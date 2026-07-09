// Tri-state rule evaluator + rule engine for the static review engine.
//
// The evaluator resolves each rule's conditions against an AppProfile using a
// three-valued (Kleene) logic: a predicate is `true`, `false`, or `unknown`.
// "unknown" means the static scan could not see enough to decide (an artifact
// was absent, or a value is an unresolved build variable). Rules pair a
// `fail_if` with an `unverified_if` so that "we don't have the data" resolves
// to `unverified` (deferred to the AI/human pass) rather than a false `pass`
// or `fail`.
//
// Evaluation order (mirrors src/engine/types.ts and forvibeapp schema.ts):
//   1. applies_if (default true when omitted): false -> "na"; unknown ->
//      "unverified"; true -> continue.
//   2. unverified_if (default false when omitted): true OR unknown ->
//      "unverified"; false -> continue.
//   3. fail_if: true -> "fail" (+ finding); unknown -> "unverified"; false ->
//      "pass".

import type {
  AppProfile,
  Condition,
  Predicate,
  CheckStatus,
  ReviewCheck,
  Rule,
  RulepackBundle,
  RuleSeverity,
  SDKRegistryEntry,
} from "./types.js";
import type { ReviewFinding } from "../types/review.js";

export interface RuleEvaluationResult {
  checks: ReviewCheck[];
  findings: ReviewFinding[];
}

// ===========================================================================
// Fact resolution (tri-state)
// ===========================================================================

export type FactResolution =
  | { kind: "unknown" } // an intermediate segment is null/undefined: artifact unseen
  | { kind: "missing" } // parent record exists, leaf key is not an own property
  | { kind: "nullvalue" } // leaf key present with value null (present but valueless)
  | { kind: "value"; value: unknown }; // leaf present with a non-null value

/**
 * Walks a dotted `path` (e.g. "ios.plist.usage_descriptions.NSFoo") against
 * `profile`, returning a tri-state resolution.
 *
 * UNKNOWN vs MISSING is the crux of the semantics:
 *   - UNKNOWN: any INTERMEDIATE segment is null/undefined (e.g. ios.plist is
 *     null because no Info.plist was found). We could not see the artifact.
 *   - MISSING: the parent chain exists but the LEAF key is not an own
 *     property (e.g. usage_descriptions record present without NSFoo). This is
 *     definitive absence.
 *   - NULLVALUE: leaf key present with value null (a nulled scalar, or a usage
 *     description whose value was an unresolved $(VAR)). Present but valueless.
 */
export function resolveFact(profile: AppProfile, path: string): FactResolution {
  const segments = path.split(".");
  let current: unknown = profile;

  for (let i = 0; i < segments.length; i++) {
    // A null/undefined value before the leaf means an intermediate segment is
    // absent: we cannot see this artifact at all -> UNKNOWN. A primitive where
    // an object is expected is likewise not navigable -> UNKNOWN.
    if (current === null || current === undefined) return { kind: "unknown" };
    if (typeof current !== "object") return { kind: "unknown" };

    const obj = current as Record<string, unknown>;
    const seg = segments[i];
    const isLeaf = i === segments.length - 1;

    if (isLeaf) {
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) return { kind: "missing" };
      const value = obj[seg];
      if (value === null || value === undefined) return { kind: "nullvalue" };
      return { kind: "value", value };
    }

    // Descend. An absent intermediate key yields undefined, which the
    // null/undefined guard at the top of the next iteration turns into UNKNOWN.
    current = obj[seg];
  }

  // Empty path (no segments) never reaches here for a real fact path.
  return { kind: "unknown" };
}

// ===========================================================================
// Tri-state predicate + condition evaluation
// ===========================================================================

export type Tri = "true" | "false" | "unknown";

function strictEquals(a: unknown, b: unknown): boolean {
  return a === b;
}

function valueIncludes(collection: unknown, needle: unknown): boolean {
  if (Array.isArray(collection)) return collection.includes(needle);
  if (typeof collection === "string") return collection.includes(String(needle));
  return false;
}

/**
 * Evaluates a `{fact, op, value}` predicate to a tri-state. The op mapping
 * table below is binding (see rsv2-task-3c2 brief). UNKNOWN parent -> unknown
 * for EVERY op.
 */
function evaluateFactPredicate(
  profile: AppProfile,
  fact: string,
  op: string,
  value: string | number | boolean | undefined
): Tri {
  const r = resolveFact(profile, fact);
  if (r.kind === "unknown") return "unknown";

  switch (op) {
    case "exists":
      // NULLVALUE -> unknown: a $(VAR) may resolve at build time; do not assert presence.
      if (r.kind === "value") return "true";
      if (r.kind === "nullvalue") return "unknown";
      return "false"; // missing

    case "absent":
      if (r.kind === "value") return "false";
      if (r.kind === "nullvalue") return "unknown";
      return "true"; // missing

    case "eq":
      // NULLVALUE/MISSING: null is the definitive value here -> eq X is false.
      if (r.kind === "value") return strictEquals(r.value, value) ? "true" : "false";
      return "false";

    case "neq":
      // NULLVALUE/MISSING -> neq X is true (this powers the encryption neq-pair).
      if (r.kind === "value") return strictEquals(r.value, value) ? "false" : "true";
      return "true";

    case "gte":
      if (r.kind === "value" && typeof r.value === "number" && typeof value === "number") {
        return r.value >= value ? "true" : "false";
      }
      return "unknown"; // non-numeric VALUE, or NULLVALUE/MISSING

    case "lte":
      if (r.kind === "value" && typeof r.value === "number" && typeof value === "number") {
        return r.value <= value ? "true" : "false";
      }
      return "unknown";

    case "includes":
      // Absence of the collection is not evidence -> NULLVALUE/MISSING unknown.
      if (r.kind === "value") return valueIncludes(r.value, value) ? "true" : "false";
      return "unknown";

    case "not_includes":
      if (r.kind === "value") return valueIncludes(r.value, value) ? "false" : "true";
      return "unknown";

    case "matches":
      if (r.kind === "value") {
        if (typeof r.value !== "string") return "unknown";
        let re: RegExp;
        try {
          re = new RegExp(String(value));
        } catch {
          // Invalid regex in content: unknown (never crash the whole review).
          return "unknown";
        }
        return re.test(r.value) ? "true" : "false";
      }
      return "unknown"; // nullvalue/missing

    default:
      return "unknown";
  }
}

/**
 * Evaluates any Condition to a tri-state. `matchedSdkIds` (optional) collects
 * the ids of SDKs that satisfied an sdk / sdk_category / sdk_flag predicate,
 * so callers can build the {{sdk_names}} interpolation set.
 */
export function evaluateCondition(
  profile: AppProfile,
  condition: Condition,
  matchedSdkIds?: Set<string>
): Tri {
  if ("all" in condition) {
    let sawUnknown = false;
    for (const child of condition.all) {
      const t = evaluateCondition(profile, child, matchedSdkIds);
      if (t === "false") return "false"; // false dominates
      if (t === "unknown") sawUnknown = true;
    }
    return sawUnknown ? "unknown" : "true";
  }

  if ("any" in condition) {
    let sawUnknown = false;
    for (const child of condition.any) {
      const t = evaluateCondition(profile, child, matchedSdkIds);
      if (t === "true") return "true"; // true dominates
      if (t === "unknown") sawUnknown = true;
    }
    return sawUnknown ? "unknown" : "false";
  }

  if ("not" in condition) {
    const t = evaluateCondition(profile, condition.not, matchedSdkIds);
    if (t === "unknown") return "unknown"; // not(unknown) = unknown
    return t === "true" ? "false" : "true";
  }

  return evaluatePredicate(profile, condition, matchedSdkIds);
}

function evaluatePredicate(
  profile: AppProfile,
  pred: Predicate,
  matchedSdkIds?: Set<string>
): Tri {
  if ("always" in pred) return "true";

  if ("sdk" in pred) {
    const hit = profile.sdks.some((s) => s.id === pred.sdk);
    if (hit && matchedSdkIds) matchedSdkIds.add(pred.sdk);
    return hit ? "true" : "false";
  }

  if ("sdk_category" in pred) {
    let hit = false;
    for (const s of profile.sdks) {
      if (s.category === pred.sdk_category) {
        hit = true;
        if (matchedSdkIds) matchedSdkIds.add(s.id);
      }
    }
    return hit ? "true" : "false";
  }

  if ("sdk_flag" in pred) {
    let hit = false;
    for (const s of profile.sdks) {
      if (s.flags[pred.sdk_flag] === true) {
        hit = true;
        if (matchedSdkIds) matchedSdkIds.add(s.id);
      }
    }
    return hit ? "true" : "false";
  }

  if ("capability" in pred) {
    return profile.capabilities.includes(pred.capability) ? "true" : "false";
  }

  if ("platform" in pred) {
    return profile.platforms.includes(pred.platform) ? "true" : "false";
  }

  // { fact, op, value }
  return evaluateFactPredicate(profile, pred.fact, pred.op, pred.value);
}

// ===========================================================================
// Interpolation + evidence rendering
// ===========================================================================

/** Replaces {{name}} placeholders using `ctx`; unknown placeholders are left intact. */
function interpolate(text: string, ctx: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key] : match
  );
}

/** Renders a resolved fact value for human-readable evidence. */
function formatFactValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((el) =>
        el && typeof el === "object" && "name" in (el as Record<string, unknown>)
          ? String((el as Record<string, unknown>).name)
          : String(el)
      )
      .join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Builds a "fact: value; fact: value" evidence summary from a rule's
 * evidence_facts. Only concrete VALUE resolutions are shown; UNKNOWN / MISSING
 * / NULLVALUE facts (and values that render to empty, e.g. []) are skipped.
 */
function buildEvidence(profile: AppProfile, facts: string[]): string {
  const parts: string[] = [];
  for (const fact of facts) {
    const r = resolveFact(profile, fact);
    if (r.kind !== "value") continue;
    const formatted = formatFactValue(r.value);
    if (formatted === "") continue;
    parts.push(`${fact}: ${formatted}`);
  }
  return parts.join("; ");
}

/** First evidence_fact whose path has a profile.evidence entry with a file. */
function firstEvidenceFile(profile: AppProfile, facts: string[]): string | undefined {
  for (const fact of facts) {
    const entry = profile.evidence[fact];
    if (entry?.file) return entry.file;
  }
  return undefined;
}

// ===========================================================================
// Template expansion: sdk_required_plist_keys
// ===========================================================================

/**
 * Expands a `template: "sdk_required_plist_keys"` rule into concrete rules,
 * one per matched profile SDK x required Info.plist key. Only keys ending in
 * "UsageDescription" are synthesized here: other required keys (e.g.
 * GADApplicationIdentifier) have dedicated rules of their own, so emitting a
 * generic "missing key" check for them would double-report.
 */
function expandTemplateRule(
  templateRule: Rule,
  profile: AppProfile,
  bundle: RulepackBundle
): Rule[] {
  const registryById = new Map<string, SDKRegistryEntry>(
    bundle.sdk_registry.map((entry) => [entry.id, entry])
  );
  const synthesized: Rule[] = [];

  for (const profileSdk of profile.sdks) {
    const entry = registryById.get(profileSdk.id);
    const requiredKeys = entry?.requires?.ios_plist_keys;
    if (!requiredKeys) continue;

    for (const req of requiredKeys) {
      if (!req.key.endsWith("UsageDescription")) continue; // dedicated rules cover these

      const guidelineName =
        bundle.guidelines[req.guideline]?.name ?? templateRule.guideline.name;
      const ctx: Record<string, string> = {
        plist_key: req.key,
        reason: req.reason,
        sdk_names: profileSdk.name,
      };

      synthesized.push({
        id: `appstore.sdk-plist.${profileSdk.id}.${req.key}`,
        store: templateRule.store,
        guideline: { number: req.guideline, name: guidelineName },
        severity: templateRule.severity,
        category: templateRule.category,
        title: interpolate(templateRule.title, ctx),
        description: interpolate(templateRule.description, ctx),
        user_impact: interpolate(templateRule.user_impact, ctx),
        fix: interpolate(templateRule.fix, ctx),
        tags: templateRule.tags,
        applies_if: { all: [{ platform: "ios" }, { sdk: profileSdk.id }] },
        unverified_if: { fact: "ios.plist", op: "absent" },
        fail_if: { fact: `ios.plist.usage_descriptions.${req.key}`, op: "absent" },
        evidence_facts: templateRule.evidence_facts,
      });
    }
  }

  return synthesized;
}

// ===========================================================================
// Per-rule evaluation
// ===========================================================================

function evaluateRule(
  profile: AppProfile,
  rule: Rule
): { check: ReviewCheck; finding?: ReviewFinding } {
  const matchedSdkIds = new Set<string>();

  // 1. applies_if (default true)
  const appliesTri: Tri = rule.applies_if
    ? evaluateCondition(profile, rule.applies_if, matchedSdkIds)
    : "true";

  let status: CheckStatus;
  let isFail = false;

  if (appliesTri === "false") {
    status = "na";
  } else if (appliesTri === "unknown") {
    status = "unverified";
  } else {
    // 2. unverified_if (default false)
    const unverifiedTri: Tri = rule.unverified_if
      ? evaluateCondition(profile, rule.unverified_if, matchedSdkIds)
      : "false";

    if (unverifiedTri === "true" || unverifiedTri === "unknown") {
      status = "unverified";
    } else {
      // 3. fail_if
      const failTri = evaluateCondition(profile, rule.fail_if, matchedSdkIds);
      if (failTri === "true") {
        status = "fail";
        isFail = true;
      } else if (failTri === "unknown") {
        status = "unverified";
      } else {
        status = "pass";
      }
    }
  }

  // {{sdk_names}}: names of the SDKs that satisfied the rule's sdk predicates,
  // in profile.sdks (id-sorted) order; empty -> "the detected SDKs".
  const sdkNames = profile.sdks
    .filter((s) => matchedSdkIds.has(s.id))
    .map((s) => s.name);
  const sdkNamesStr = sdkNames.length > 0 ? sdkNames.join(", ") : "the detected SDKs";

  const evidenceStr = buildEvidence(profile, rule.evidence_facts);
  const ctx: Record<string, string> = { sdk_names: sdkNamesStr, evidence: evidenceStr };
  const title = interpolate(rule.title, ctx);

  const check: ReviewCheck = {
    rule_id: rule.id,
    title,
    status,
    severity: rule.severity,
    guideline_number: rule.guideline.number,
  };
  if (evidenceStr) check.evidence = evidenceStr;

  let finding: ReviewFinding | undefined;
  if (isFail) {
    check.finding_id = rule.id;
    finding = {
      id: rule.id,
      title,
      risk_level: rule.severity,
      category: rule.category,
      source: "codebase",
      detection: "static",
      guideline_number: rule.guideline.number,
      guideline_name: rule.guideline.name,
      description: interpolate(rule.description, ctx),
      user_impact: interpolate(rule.user_impact, ctx),
      evidence: evidenceStr,
      recommendation: interpolate(rule.fix, ctx),
      rule_id: rule.id,
    };
    const file = firstEvidenceFile(profile, rule.evidence_facts);
    if (file) finding.file = file;
  }

  return { check, finding };
}

// ===========================================================================
// Ordering
// ===========================================================================

const STATUS_ORDER: Record<CheckStatus, number> = {
  fail: 0,
  unverified: 1,
  pass: 2,
  na: 3,
};

const SEVERITY_ORDER: Record<RuleSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Evaluates every rule in `bundle` against `profile`, expanding template rules
 * per matched SDK. Produces exactly one ReviewCheck per non-template rule and
 * per synthesized rule, and a ReviewFinding for each `fail` check.
 *
 * Deterministic ordering: checks by status (fail, unverified, pass, na), then
 * severity (high -> info), then rule id; findings by severity then rule id.
 */
export function evaluateRules(
  profile: AppProfile,
  bundle: RulepackBundle
): RuleEvaluationResult {
  const effectiveRules: Rule[] = [];
  for (const rule of bundle.rules) {
    if (rule.template === "sdk_required_plist_keys") {
      effectiveRules.push(...expandTemplateRule(rule, profile, bundle));
    } else if (rule.template) {
      // Unknown template kind: skip rather than mis-evaluate its placeholder
      // fail_if directly.
      continue;
    } else {
      effectiveRules.push(rule);
    }
  }

  const checks: ReviewCheck[] = [];
  const findings: ReviewFinding[] = [];
  const seenIds = new Set<string>();

  for (const rule of effectiveRules) {
    if (seenIds.has(rule.id)) continue; // dedupe (safety net for synthesized ids)
    seenIds.add(rule.id);
    const { check, finding } = evaluateRule(profile, rule);
    checks.push(check);
    if (finding) findings.push(finding);
  }

  checks.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareIds(a.rule_id, b.rule_id)
  );

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.risk_level] - SEVERITY_ORDER[b.risk_level] ||
      compareIds(a.rule_id ?? a.id, b.rule_id ?? b.id)
  );

  return { checks, findings };
}
