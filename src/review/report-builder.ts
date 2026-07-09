// ReportV2 assembly: merges static-engine output and (optional) AI findings
// into a CodeReviewReport, with a DETERMINISTIC summary.
//
// The summary is always computed here from the merged findings - never taken
// from the LLM's own estimatedOutcome/estimatedApprovalChance. Why: scoring
// must be consistent between static-only CLI runs, hybrid CLI runs, and the
// server's combined formula; an LLM's self-estimate varies run to run and
// cannot see the static findings' weight. The LLM's prose assessment is kept
// verbatim as summary.ai_assessment only.

import type { AppProfile, EcosystemDeps, ReviewCheck } from "../engine/types.js";
import type {
  CodeReviewReport,
  ReviewFinding,
  ReviewOutcome,
  ReviewRiskLevel,
  ReviewSummary,
} from "../types/review.js";

const SEVERITY_ORDER: Record<ReviewRiskLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

export interface DeterministicSummaryOptions {
  /** Whether the AI behavioral pass actually ran. */
  aiReviewRan: boolean;
  /** The LLM's prose assessment; used only when aiReviewRan is true. */
  aiAssessment?: string;
  /** Total compliance checks evaluated; used in the synthesized static-only assessment. */
  checksCount?: number;
}

/**
 * Deterministic summary over the MERGED findings (static + AI):
 *   estimated_approval_chance = clamp(85 - 20*high - 5*medium - 1*low, 5, 95)
 *   outcome: high>=2 -> likely-rejected; high>=1 or medium>=3 -> needs-attention;
 *            else likely-approved
 *   top_risks: up to 3 titles of the highest-severity findings
 */
export function buildDeterministicSummary(
  findings: ReviewFinding[],
  opts: DeterministicSummaryOptions
): ReviewSummary {
  const high = findings.filter((f) => f.risk_level === "high").length;
  const medium = findings.filter((f) => f.risk_level === "medium").length;
  const low = findings.filter((f) => f.risk_level === "low").length;
  const info = findings.filter((f) => f.risk_level === "info").length;

  const rawChance = 85 - 20 * high - 5 * medium - 1 * low;
  const estimatedApprovalChance = Math.min(95, Math.max(5, rawChance));

  let outcome: ReviewOutcome;
  if (high >= 2) {
    outcome = "likely-rejected";
  } else if (high >= 1 || medium >= 3) {
    outcome = "needs-attention";
  } else {
    outcome = "likely-approved";
  }

  const topRisks = [...findings]
    .sort((a, b) => SEVERITY_ORDER[a.risk_level] - SEVERITY_ORDER[b.risk_level])
    .slice(0, 3)
    .map((f) => f.title);

  let aiAssessment: string;
  if (opts.aiReviewRan && opts.aiAssessment) {
    aiAssessment = opts.aiAssessment;
  } else {
    const violations = findings.length === 1 ? "violation" : "violations";
    aiAssessment = `Static rule scan found ${findings.length} guideline ${violations} across ${opts.checksCount ?? 0} checks. AI behavioral review was not run.`;
  }

  return {
    total_findings: findings.length,
    high_risk: high,
    medium_risk: medium,
    low_risk: low,
    info,
    outcome,
    estimated_approval_chance: estimatedApprovalChance,
    top_risks: topRisks,
    ai_assessment: aiAssessment,
  };
}

// Caps each raw_dependencies bucket at 50 entries: keeps the
// /api/review/codebase payload bounded (a large RN monorepo can carry
// thousands of npm deps; the full list adds no review value server-side).
const RAW_DEPS_CAP = 50;

/** Returns a copy of `profile` with every raw_dependencies bucket capped at 50 entries. */
export function trimProfileForReport(profile: AppProfile): AppProfile {
  const raw = profile.raw_dependencies;
  const trimmed = Object.fromEntries(
    Object.entries(raw).map(([bucket, entries]) => [bucket, entries.slice(0, RAW_DEPS_CAP)])
  ) as unknown as EcosystemDeps;
  return { ...profile, raw_dependencies: trimmed };
}

export interface AssembleReportInput {
  platform: string;
  bundleId: string | null;
  sourceFilesAnalyzed: number;
  /** AI pass-1 feature names; [] on the static-only path (capabilities live in app_profile.capabilities). */
  featuresDetected: string[];
  staticFindings: ReviewFinding[];
  /** Deduped AI findings (detection "ai"); [] on the static-only path. */
  aiFindings: ReviewFinding[];
  checks: ReviewCheck[];
  profile: AppProfile;
  rulepack: { version: string; store: "appstore" | "play"; source: "remote" | "cache" | "bundled" };
  /** CLI package version (reported as engine_version). */
  engineVersion: string;
  aiReviewRan: boolean;
  aiAssessment?: string;
  ragStoriesUsed: number;
  scanDurationMs: number;
}

/**
 * Assembles the v2 report. Findings order: static first (already sorted by
 * severity by the engine), then AI findings.
 */
export function assembleReportV2(input: AssembleReportInput): CodeReviewReport {
  const findings = [...input.staticFindings, ...input.aiFindings];
  const summary = buildDeterministicSummary(findings, {
    aiReviewRan: input.aiReviewRan,
    aiAssessment: input.aiAssessment,
    checksCount: input.checks.length,
  });

  return {
    features_detected: input.featuresDetected,
    source_files_analyzed: input.sourceFilesAnalyzed,
    platform: input.platform,
    bundle_id: input.bundleId,
    findings,
    summary,
    rag_stories_used: input.ragStoriesUsed,
    scan_duration_ms: input.scanDurationMs,
    report_schema_version: 2,
    engine_version: input.engineVersion,
    rulepack_version: input.rulepack.version,
    rulepack_store: input.rulepack.store,
    rulepack_source: input.rulepack.source,
    app_profile: trimProfileForReport(input.profile),
    checks: input.checks,
    ai_review_ran: input.aiReviewRan,
  };
}
