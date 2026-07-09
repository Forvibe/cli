import { describe, it, expect } from "vitest";
import {
  resolveFact,
  evaluateCondition,
  evaluateRules,
} from "../../src/engine/rules.js";
import type {
  AppProfile,
  Condition,
  Rule,
  RulepackBundle,
  SDKRegistryEntry,
  ProfileSDK,
  GuidelineIndex,
} from "../../src/engine/types.js";

// ---------------------------------------------------------------------------
// Handcrafted mini fixtures (NOT the real snapshot) for precise truth tables.
// ---------------------------------------------------------------------------

function baseProfile(overrides: Partial<AppProfile> = {}): AppProfile {
  return {
    schema_version: 1,
    generated_at: "2026-07-09T00:00:00.000Z",
    stack: "swift",
    stack_label: "Swift / SwiftUI",
    platforms: ["ios"],
    app: {
      name: "Mini",
      bundle_id: "com.mini",
      version: "1.0.0",
      min_ios_version: null,
      min_android_sdk: null,
      target_android_sdk: null,
    },
    sdks: [],
    raw_dependencies: {
      npm: [],
      pub: [],
      pods: [],
      spm: [],
      gradle: [],
      nuget: [],
      upm: [],
      ios_imports: [],
      android_imports: [],
    },
    ios: null,
    android: null,
    capabilities: [],
    signals: {
      restore_purchases_found: null,
      account_deletion_found: null,
      privacy_policy_link_found: null,
      external_checkout_url_found: null,
      webview_ratio: null,
    },
    evidence: {},
    stats: { files_scanned: 0, source_chars_read: 0 },
    ...overrides,
  };
}

function emptyPlist(): NonNullable<NonNullable<AppProfile["ios"]>["plist"]> {
  return {
    usage_descriptions: {},
    background_modes: [],
    ats_allows_arbitrary_loads: null,
    gad_application_identifier: null,
    sk_ad_network_count: 0,
    non_exempt_encryption: null,
    required_device_capabilities: [],
    other_keys: [],
  };
}

function iosProfile(
  plist: Partial<NonNullable<NonNullable<AppProfile["ios"]>["plist"]>> | null,
  overrides: Partial<AppProfile> = {}
): AppProfile {
  return baseProfile({
    ios: {
      plist_source: plist ? "plist_file" : "none",
      plist: plist ? { ...emptyPlist(), ...plist } : null,
      entitlements: null,
      privacy_manifest: null,
    },
    ...overrides,
  });
}

function sdk(id: string, extra: Partial<ProfileSDK> = {}): ProfileSDK {
  return {
    id,
    name: extra.name ?? id,
    category: extra.category ?? "other",
    matched_coordinates: extra.matched_coordinates ?? [`pods:${id}`],
    data_collection: extra.data_collection ?? [],
    flags: extra.flags ?? {},
  };
}

// ===========================================================================
// resolveFact — tri-state (UNKNOWN / MISSING / NULLVALUE / VALUE)
// ===========================================================================

describe("resolveFact tri-state resolution", () => {
  it("UNKNOWN when an intermediate segment is null (ios.plist is null)", () => {
    const p = iosProfile(null);
    expect(resolveFact(p, "ios.plist.non_exempt_encryption")).toEqual({
      kind: "unknown",
    });
  });

  it("UNKNOWN when a top intermediate is null (ios is null -> android-only app)", () => {
    const p = baseProfile({ ios: null });
    expect(resolveFact(p, "ios.plist.gad_application_identifier")).toEqual({
      kind: "unknown",
    });
  });

  it("MISSING when parent record exists but leaf key is not an own property", () => {
    const p = iosProfile({ usage_descriptions: { NSCameraUsageDescription: "x" } });
    expect(
      resolveFact(p, "ios.plist.usage_descriptions.NSUserTrackingUsageDescription")
    ).toEqual({ kind: "missing" });
  });

  it("NULLVALUE when leaf key present with value null (nulled scalar)", () => {
    const p = iosProfile({ non_exempt_encryption: null });
    // key is always an own property on the plist object -> present, value null
    expect(resolveFact(p, "ios.plist.non_exempt_encryption")).toEqual({
      kind: "nullvalue",
    });
  });

  it("NULLVALUE when a usage description is present but unresolved ($(VAR) -> null)", () => {
    const p = iosProfile({ usage_descriptions: { NSPhotoLibraryUsageDescription: null } });
    expect(
      resolveFact(p, "ios.plist.usage_descriptions.NSPhotoLibraryUsageDescription")
    ).toEqual({ kind: "nullvalue" });
  });

  it("VALUE when leaf present with a non-null value", () => {
    const p = iosProfile({ ats_allows_arbitrary_loads: true });
    expect(resolveFact(p, "ios.plist.ats_allows_arbitrary_loads")).toEqual({
      kind: "value",
      value: true,
    });
  });

  it("VALUE for an array leaf (even empty array is a present value)", () => {
    const p = baseProfile({ sdks: [] });
    expect(resolveFact(p, "sdks")).toEqual({ kind: "value", value: [] });
  });

  it("VALUE false is a value, not missing/null", () => {
    const p = baseProfile({
      signals: {
        restore_purchases_found: null,
        account_deletion_found: false,
        privacy_policy_link_found: null,
        external_checkout_url_found: null,
        webview_ratio: null,
      },
    });
    expect(resolveFact(p, "signals.account_deletion_found")).toEqual({
      kind: "value",
      value: false,
    });
  });

  it("NULLVALUE for a signals field explicitly null", () => {
    const p = baseProfile();
    expect(resolveFact(p, "signals.account_deletion_found")).toEqual({
      kind: "nullvalue",
    });
  });
});

// ===========================================================================
// Predicate op x resolution truth tables (via single-predicate conditions)
// ===========================================================================

// Helper: evaluate a fact predicate against a plist state.
function opAgainstPlist(
  op: "exists" | "absent" | "eq" | "neq" | "gte" | "lte" | "includes" | "not_includes" | "matches",
  factLeaf: string,
  plist: Partial<NonNullable<NonNullable<AppProfile["ios"]>["plist"]>> | null,
  value?: string | number | boolean
) {
  const p = iosProfile(plist);
  const cond: Condition = { fact: `ios.plist.${factLeaf}`, op, value } as Condition;
  return evaluateCondition(p, cond);
}

describe("predicate op truth tables", () => {
  // ---- UNKNOWN parent -> unknown for EVERY op ----
  it("UNKNOWN parent yields unknown for every op", () => {
    const ops = ["exists", "absent", "eq", "neq", "gte", "lte", "includes", "not_includes", "matches"] as const;
    for (const op of ops) {
      // ios.plist is null -> parent unknown
      expect(opAgainstPlist(op, "non_exempt_encryption", null, true)).toBe("unknown");
    }
  });

  // ---- exists ----
  it("exists: VALUE->true, NULLVALUE->unknown, MISSING->false", () => {
    expect(opAgainstPlist("exists", "gad_application_identifier", { gad_application_identifier: "id" })).toBe("true");
    expect(opAgainstPlist("exists", "gad_application_identifier", { gad_application_identifier: null })).toBe("unknown");
    // usage_descriptions record present without the key -> MISSING
    const p = iosProfile({ usage_descriptions: {} });
    expect(evaluateCondition(p, { fact: "ios.plist.usage_descriptions.NSFoo", op: "exists" })).toBe("false");
  });

  // ---- absent ----
  it("absent: VALUE->false, NULLVALUE->unknown, MISSING->true", () => {
    expect(opAgainstPlist("absent", "gad_application_identifier", { gad_application_identifier: "id" })).toBe("false");
    expect(opAgainstPlist("absent", "gad_application_identifier", { gad_application_identifier: null })).toBe("unknown");
    const p = iosProfile({ usage_descriptions: {} });
    expect(evaluateCondition(p, { fact: "ios.plist.usage_descriptions.NSFoo", op: "absent" })).toBe("true");
  });

  // ---- eq ----
  it("eq: VALUE strict compare; NULLVALUE->false; MISSING->false", () => {
    expect(opAgainstPlist("eq", "ats_allows_arbitrary_loads", { ats_allows_arbitrary_loads: true }, true)).toBe("true");
    expect(opAgainstPlist("eq", "ats_allows_arbitrary_loads", { ats_allows_arbitrary_loads: false }, true)).toBe("false");
    // NULLVALUE eq X -> false (null is the definitive runtime value)
    expect(opAgainstPlist("eq", "non_exempt_encryption", { non_exempt_encryption: null }, true)).toBe("false");
    expect(opAgainstPlist("eq", "non_exempt_encryption", { non_exempt_encryption: null }, false)).toBe("false");
    // MISSING eq X -> false
    const p = iosProfile({ usage_descriptions: {} });
    expect(evaluateCondition(p, { fact: "ios.plist.usage_descriptions.NSFoo", op: "eq", value: "x" })).toBe("false");
  });

  it("eq: strict number and string compares", () => {
    expect(opAgainstPlist("eq", "sk_ad_network_count", { sk_ad_network_count: 2 }, 2)).toBe("true");
    expect(opAgainstPlist("eq", "sk_ad_network_count", { sk_ad_network_count: 2 }, 3)).toBe("false");
    expect(opAgainstPlist("eq", "gad_application_identifier", { gad_application_identifier: "ca-app" }, "ca-app")).toBe("true");
  });

  // ---- neq ----
  it("neq: VALUE strict compare; NULLVALUE->true; MISSING->true", () => {
    expect(opAgainstPlist("neq", "ats_allows_arbitrary_loads", { ats_allows_arbitrary_loads: true }, true)).toBe("false");
    expect(opAgainstPlist("neq", "ats_allows_arbitrary_loads", { ats_allows_arbitrary_loads: false }, true)).toBe("true");
    // NULLVALUE neq X -> true (the encryption neq-pair depends on this)
    expect(opAgainstPlist("neq", "non_exempt_encryption", { non_exempt_encryption: null }, true)).toBe("true");
    expect(opAgainstPlist("neq", "non_exempt_encryption", { non_exempt_encryption: null }, false)).toBe("true");
    // MISSING neq X -> true
    const p = iosProfile({ usage_descriptions: {} });
    expect(evaluateCondition(p, { fact: "ios.plist.usage_descriptions.NSFoo", op: "neq", value: "x" })).toBe("true");
  });

  it("neq-pair over a boolean fact: NULLVALUE -> all true; declared value -> false", () => {
    // Pure combinator truth table: all[ neq true, neq false ] isolates a
    // present-but-null boolean. (Rulepack 2.0.1 briefly used this for the
    // encryption rule; 2.0.2 reverted to `absent` under the omitted-vs-null
    // extractor contract. The evaluator semantics tested here are unchanged.)
    const neqPair: Condition = {
      all: [
        { fact: "ios.plist.non_exempt_encryption", op: "neq", value: true },
        { fact: "ios.plist.non_exempt_encryption", op: "neq", value: false },
      ],
    };
    // NULLVALUE (property present with value null): both neq -> true -> all true.
    expect(evaluateCondition(iosProfile({ non_exempt_encryption: null }), neqPair)).toBe("true");
    // Declared false: neq true -> true, neq false -> false -> all false.
    expect(evaluateCondition(iosProfile({ non_exempt_encryption: false }), neqPair)).toBe("false");
    // Declared true: neq true -> false -> all false.
    expect(evaluateCondition(iosProfile({ non_exempt_encryption: true }), neqPair)).toBe("false");
    // ios.plist absent -> parent unknown -> all unknown.
    expect(evaluateCondition(iosProfile(null), neqPair)).toBe("unknown");
  });

  // ---- gte / lte ----
  it("gte/lte: VALUE numeric compare; non-numeric->unknown; NULLVALUE/MISSING->unknown", () => {
    const p = baseProfile({
      signals: {
        restore_purchases_found: null,
        account_deletion_found: null,
        privacy_policy_link_found: null,
        external_checkout_url_found: null,
        webview_ratio: 0.6,
      },
    });
    expect(evaluateCondition(p, { fact: "signals.webview_ratio", op: "gte", value: 0.6 })).toBe("true");
    expect(evaluateCondition(p, { fact: "signals.webview_ratio", op: "gte", value: 0.7 })).toBe("false");
    expect(evaluateCondition(p, { fact: "signals.webview_ratio", op: "lte", value: 0.6 })).toBe("true");
    // NULLVALUE -> unknown
    const pn = baseProfile();
    expect(evaluateCondition(pn, { fact: "signals.webview_ratio", op: "gte", value: 0.6 })).toBe("unknown");
    // non-numeric VALUE -> unknown
    expect(opAgainstPlist("gte", "gad_application_identifier", { gad_application_identifier: "abc" }, 1)).toBe("unknown");
  });

  // ---- includes / not_includes ----
  it("includes/not_includes: VALUE membership; NULLVALUE/MISSING->unknown", () => {
    expect(opAgainstPlist("includes", "background_modes", { background_modes: ["audio", "location"] }, "location")).toBe("true");
    expect(opAgainstPlist("includes", "background_modes", { background_modes: ["audio"] }, "location")).toBe("false");
    expect(opAgainstPlist("not_includes", "background_modes", { background_modes: ["audio"] }, "location")).toBe("true");
    expect(opAgainstPlist("not_includes", "background_modes", { background_modes: ["location"] }, "location")).toBe("false");
    // string membership
    expect(opAgainstPlist("includes", "gad_application_identifier", { gad_application_identifier: "ca-app-pub-123" }, "app-pub")).toBe("true");
    // NULLVALUE -> unknown for BOTH includes and not_includes
    expect(opAgainstPlist("includes", "gad_application_identifier", { gad_application_identifier: null }, "x")).toBe("unknown");
    expect(opAgainstPlist("not_includes", "gad_application_identifier", { gad_application_identifier: null }, "x")).toBe("unknown");
  });

  // ---- matches ----
  it("matches: VALUE regex; invalid regex -> unknown (no crash); NULLVALUE/MISSING->unknown", () => {
    expect(opAgainstPlist("matches", "gad_application_identifier", { gad_application_identifier: "ca-app-pub-42" }, "^ca-app")).toBe("true");
    expect(opAgainstPlist("matches", "gad_application_identifier", { gad_application_identifier: "nope" }, "^ca-app")).toBe("false");
    // invalid regex -> unknown, does not throw
    expect(() =>
      opAgainstPlist("matches", "gad_application_identifier", { gad_application_identifier: "x" }, "[")
    ).not.toThrow();
    expect(opAgainstPlist("matches", "gad_application_identifier", { gad_application_identifier: "x" }, "[")).toBe("unknown");
    // NULLVALUE -> unknown
    expect(opAgainstPlist("matches", "gad_application_identifier", { gad_application_identifier: null }, ".*")).toBe("unknown");
  });
});

// ===========================================================================
// Non-fact predicates
// ===========================================================================

describe("non-fact predicates", () => {
  it("always -> true", () => {
    expect(evaluateCondition(baseProfile(), { always: true })).toBe("true");
  });

  it("platform / capability / sdk / sdk_category / sdk_flag are always definitive", () => {
    const p = baseProfile({
      platforms: ["ios"],
      capabilities: ["ads", "iap"],
      sdks: [sdk("google-mobile-ads", { category: "ads", flags: { att_required: true } })],
    });
    expect(evaluateCondition(p, { platform: "ios" })).toBe("true");
    expect(evaluateCondition(p, { platform: "android" })).toBe("false");
    expect(evaluateCondition(p, { capability: "ads" })).toBe("true");
    expect(evaluateCondition(p, { capability: "tracking" })).toBe("false");
    expect(evaluateCondition(p, { sdk: "google-mobile-ads" })).toBe("true");
    expect(evaluateCondition(p, { sdk: "stripe" })).toBe("false");
    expect(evaluateCondition(p, { sdk_category: "ads" })).toBe("true");
    expect(evaluateCondition(p, { sdk_category: "analytics" })).toBe("false");
    expect(evaluateCondition(p, { sdk_flag: "att_required" })).toBe("true");
    expect(evaluateCondition(p, { sdk_flag: "advertising" })).toBe("false");
  });
});

// ===========================================================================
// Kleene combinators
// ===========================================================================

describe("Kleene combinators", () => {
  const T: Condition = { always: true };
  const F: Condition = { platform: "android" }; // false on an ios-only profile
  // unknown predicate: a NULLVALUE under exists
  const U: Condition = { fact: "ios.plist.non_exempt_encryption", op: "exists" };
  const p = iosProfile({ non_exempt_encryption: null }); // U -> unknown, F -> false, T -> true

  it("all: any false -> false; else any unknown -> unknown; else true", () => {
    expect(evaluateCondition(p, { all: [T, T] })).toBe("true");
    expect(evaluateCondition(p, { all: [T, U] })).toBe("unknown");
    expect(evaluateCondition(p, { all: [T, F] })).toBe("false");
    expect(evaluateCondition(p, { all: [U, F] })).toBe("false"); // false dominates unknown
    expect(evaluateCondition(p, { all: [] })).toBe("true"); // vacuous
  });

  it("any: any true -> true; else any unknown -> unknown; else false", () => {
    expect(evaluateCondition(p, { any: [F, F] })).toBe("false");
    expect(evaluateCondition(p, { any: [F, U] })).toBe("unknown");
    expect(evaluateCondition(p, { any: [F, T] })).toBe("true");
    expect(evaluateCondition(p, { any: [U, T] })).toBe("true"); // true dominates unknown
    expect(evaluateCondition(p, { any: [] })).toBe("false"); // vacuous
  });

  it("not: unknown -> unknown; else negate", () => {
    expect(evaluateCondition(p, { not: T })).toBe("false");
    expect(evaluateCondition(p, { not: F })).toBe("true");
    expect(evaluateCondition(p, { not: U })).toBe("unknown"); // not(unknown) = unknown
  });

  it("nested combinators propagate unknown correctly", () => {
    // all[ any[F, U], T ] -> any[F,U]=unknown -> all=unknown
    expect(evaluateCondition(p, { all: [{ any: [F, U] }, T] })).toBe("unknown");
    // any[ all[T, F], U ] -> all=false, U=unknown -> any=unknown
    expect(evaluateCondition(p, { any: [{ all: [T, F] }, U] })).toBe("unknown");
    // not(all[T,F]) -> not(false) -> true
    expect(evaluateCondition(p, { not: { all: [T, F] } })).toBe("true");
  });
});

// ===========================================================================
// Status ladder (na -> unverified -> fail -> pass) + omitted-condition defaults
// ===========================================================================

function miniBundle(rules: Rule[], registry: SDKRegistryEntry[] = [], guidelines: GuidelineIndex = {}): RulepackBundle {
  return {
    schema_version: 1,
    store: "appstore",
    version: "test",
    updated_at: "2026-07-09",
    rules,
    sdk_registry: registry,
    stories: [],
    guidelines,
  };
}

function rule(partial: Partial<Rule> & { id: string; fail_if: Condition }): Rule {
  return {
    store: "appstore",
    guideline: { number: "2.1", name: "App Completeness" },
    severity: "medium",
    category: "safety",
    title: "T",
    description: "D",
    user_impact: "U",
    fix: "F",
    evidence_facts: [],
    ...partial,
  };
}

function statusOf(bundle: RulepackBundle, profile: AppProfile, ruleId: string) {
  const { checks } = evaluateRules(profile, bundle);
  return checks.find((c) => c.rule_id === ruleId)?.status;
}

describe("check status ladder", () => {
  it("applies_if false -> na (beats everything below)", () => {
    const b = miniBundle([
      rule({ id: "r", applies_if: { platform: "android" }, fail_if: { always: true } }),
    ]);
    expect(statusOf(b, baseProfile(), "r")).toBe("na");
  });

  it("applies_if unknown -> unverified", () => {
    const b = miniBundle([
      rule({
        id: "r",
        applies_if: { fact: "ios.plist.non_exempt_encryption", op: "exists" }, // NULLVALUE -> unknown
        fail_if: { always: true },
      }),
    ]);
    expect(statusOf(b, iosProfile({ non_exempt_encryption: null }), "r")).toBe("unverified");
  });

  it("omitted applies_if defaults to true (continue)", () => {
    const b = miniBundle([rule({ id: "r", fail_if: { always: true } })]);
    expect(statusOf(b, baseProfile(), "r")).toBe("fail");
  });

  it("unverified_if true -> unverified (beats fail)", () => {
    const b = miniBundle([
      rule({ id: "r", unverified_if: { always: true }, fail_if: { always: true } }),
    ]);
    expect(statusOf(b, baseProfile(), "r")).toBe("unverified");
  });

  it("unverified_if unknown -> unverified", () => {
    const b = miniBundle([
      rule({
        id: "r",
        unverified_if: { fact: "ios.plist.non_exempt_encryption", op: "exists" },
        fail_if: { always: true },
      }),
    ]);
    expect(statusOf(b, iosProfile({ non_exempt_encryption: null }), "r")).toBe("unverified");
  });

  it("omitted unverified_if defaults to false (continue to fail_if)", () => {
    const b = miniBundle([rule({ id: "r", fail_if: { always: true } })]);
    expect(statusOf(b, baseProfile(), "r")).toBe("fail");
  });

  it("fail_if true -> fail; unknown -> unverified; false -> pass", () => {
    const bFail = miniBundle([rule({ id: "r", fail_if: { always: true } })]);
    expect(statusOf(bFail, baseProfile(), "r")).toBe("fail");
    const bUnknown = miniBundle([
      rule({ id: "r", fail_if: { fact: "ios.plist.non_exempt_encryption", op: "exists" } }),
    ]);
    expect(statusOf(bUnknown, iosProfile({ non_exempt_encryption: null }), "r")).toBe("unverified");
    const bPass = miniBundle([rule({ id: "r", fail_if: { platform: "android" } })]);
    expect(statusOf(bPass, baseProfile(), "r")).toBe("pass");
  });
});

// ===========================================================================
// Findings — only for fails, additive detection/rule_id, interpolation
// ===========================================================================

describe("findings", () => {
  it("emits a finding only for fail checks, with detection static + rule_id", () => {
    const b = miniBundle([
      rule({ id: "fail-rule", severity: "high", category: "legal", fail_if: { always: true } }),
      rule({ id: "pass-rule", fail_if: { platform: "android" } }),
    ]);
    const { checks, findings } = evaluateRules(baseProfile(), b);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.id).toBe("fail-rule");
    expect(f.rule_id).toBe("fail-rule");
    expect(f.detection).toBe("static");
    expect(f.source).toBe("codebase");
    expect(f.risk_level).toBe("high");
    expect(f.category).toBe("legal");
    // the fail check carries a finding_id linking to the finding
    const failCheck = checks.find((c) => c.rule_id === "fail-rule");
    expect(failCheck?.finding_id).toBe("fail-rule");
    const passCheck = checks.find((c) => c.rule_id === "pass-rule");
    expect(passCheck?.finding_id).toBeUndefined();
  });

  it("interpolates {{sdk_names}} from the sdk predicates that matched, else default", () => {
    const profile = baseProfile({
      sdks: [
        sdk("appsflyer", { name: "AppsFlyer", flags: { att_required: true } }),
        sdk("google-mobile-ads", { name: "Google AdMob (Mobile Ads SDK)", category: "ads", flags: { att_required: true } }),
      ],
    });
    const b = miniBundle([
      rule({
        id: "att",
        title: "Tracking SDK present ({{sdk_names}})",
        description: "The app includes {{sdk_names}}.",
        applies_if: { sdk_flag: "att_required" },
        fail_if: { always: true },
      }),
    ]);
    const { checks, findings } = evaluateRules(profile, b);
    const c = checks.find((c) => c.rule_id === "att");
    // names in profile.sdks (id-sorted) order
    expect(c?.title).toBe("Tracking SDK present (AppsFlyer, Google AdMob (Mobile Ads SDK))");
    expect(findings[0].description).toBe("The app includes AppsFlyer, Google AdMob (Mobile Ads SDK).");
  });

  it("{{sdk_names}} defaults to 'the detected SDKs' when no sdk predicate matched", () => {
    const b = miniBundle([
      rule({ id: "r", title: "{{sdk_names}}", fail_if: { always: true } }),
    ]);
    const { checks } = evaluateRules(baseProfile(), b);
    expect(checks.find((c) => c.rule_id === "r")?.title).toBe("the detected SDKs");
  });

  it("finding.evidence summarizes evidence_facts (VALUE only, skips unknown/missing)", () => {
    const profile = baseProfile({
      capabilities: ["ads", "health"],
      signals: {
        restore_purchases_found: null,
        account_deletion_found: false,
        privacy_policy_link_found: null,
        external_checkout_url_found: null,
        webview_ratio: null,
      },
      evidence: { "signals.account_deletion_found": { file: "App.tsx" } },
    });
    const b = miniBundle([
      rule({
        id: "r",
        fail_if: { always: true },
        evidence_facts: [
          "signals.account_deletion_found", // VALUE false
          "capabilities", // VALUE array
          "ios.plist.non_exempt_encryption", // UNKNOWN (ios null) -> skipped
        ],
      }),
    ]);
    const { findings } = evaluateRules(profile, b);
    const f = findings[0];
    expect(f.evidence).toContain("signals.account_deletion_found: false");
    expect(f.evidence).toContain("capabilities: ads, health");
    expect(f.evidence).not.toContain("non_exempt_encryption");
    // file from the first evidence_fact that has a profile.evidence entry
    expect(f.file).toBe("App.tsx");
  });
});

// ===========================================================================
// Template expansion: sdk_required_plist_keys
// ===========================================================================

function registryEntry(
  id: string,
  keys: { key: string; reason: string; guideline: string }[]
): SDKRegistryEntry {
  return {
    id,
    name: id === "healthkit" ? "HealthKit" : id,
    category: "other",
    match: {},
    data_collection: [],
    flags: {},
    requires: { ios_plist_keys: keys },
  };
}

function templateRule(): Rule {
  return rule({
    id: "appstore.sdk-required-plist-key-missing",
    severity: "high",
    category: "safety",
    guideline: { number: "5.1.1", name: "Data Collection and Storage" },
    title: "SDK requires an Info.plist key that is missing",
    description: "A detected SDK requires the {{plist_key}} Info.plist key which is missing.",
    user_impact: "Missing {{plist_key}} for {{sdk_names}}.",
    fix: "Add the {{plist_key}} key. {{reason}}",
    template: "sdk_required_plist_keys",
    fail_if: { always: true },
    evidence_facts: ["sdks"],
    tags: ["permissions"],
  });
}

describe("template expansion (sdk_required_plist_keys)", () => {
  const guidelines: GuidelineIndex = {
    "5.1.1": { name: "Data Collection and Storage", summary: "s", section: "Legal" },
  };

  it("healthkit with 2 UsageDescription requirements -> 2 synthesized checks with correct ids/conditions", () => {
    const profile = iosProfile(
      { usage_descriptions: {} }, // no health keys present -> both fail
      { sdks: [sdk("healthkit", { name: "HealthKit", category: "health" })] }
    );
    const b = miniBundle(
      [templateRule()],
      [
        registryEntry("healthkit", [
          { key: "NSHealthShareUsageDescription", reason: "Required to read data from HealthKit", guideline: "5.1.1" },
          { key: "NSHealthUpdateUsageDescription", reason: "Required to write data to HealthKit", guideline: "5.1.1" },
        ]),
      ],
      guidelines
    );
    const { checks } = evaluateRules(profile, b);
    const share = checks.find((c) => c.rule_id === "appstore.sdk-plist.healthkit.NSHealthShareUsageDescription");
    const update = checks.find((c) => c.rule_id === "appstore.sdk-plist.healthkit.NSHealthUpdateUsageDescription");
    expect(share).toBeDefined();
    expect(update).toBeDefined();
    expect(share?.status).toBe("fail");
    expect(update?.status).toBe("fail");
    expect(share?.severity).toBe("high");
    expect(share?.guideline_number).toBe("5.1.1");
    // template rule itself is NOT emitted as a check
    expect(checks.find((c) => c.rule_id === "appstore.sdk-required-plist-key-missing")).toBeUndefined();
  });

  it("interpolates {{plist_key}}, {{reason}}, {{sdk_names}} into synthesized content", () => {
    const profile = iosProfile(
      { usage_descriptions: {} },
      { sdks: [sdk("healthkit", { name: "HealthKit", category: "health" })] }
    );
    const b = miniBundle(
      [templateRule()],
      [
        registryEntry("healthkit", [
          { key: "NSHealthShareUsageDescription", reason: "Required to read data from HealthKit", guideline: "5.1.1" },
        ]),
      ],
      guidelines
    );
    const { findings } = evaluateRules(profile, b);
    const f = findings.find((f) => f.rule_id === "appstore.sdk-plist.healthkit.NSHealthShareUsageDescription");
    expect(f?.description).toBe("A detected SDK requires the NSHealthShareUsageDescription Info.plist key which is missing.");
    expect(f?.recommendation).toBe("Add the NSHealthShareUsageDescription key. Required to read data from HealthKit");
    expect(f?.user_impact).toBe("Missing NSHealthShareUsageDescription for HealthKit.");
    expect(f?.guideline_name).toBe("Data Collection and Storage");
  });

  it("SKIPS non-UsageDescription required keys (dedicated rules cover those)", () => {
    const profile = iosProfile(
      { gad_application_identifier: null },
      { sdks: [sdk("google-mobile-ads", { name: "Google AdMob", category: "ads" })] }
    );
    const b = miniBundle(
      [templateRule()],
      [registryEntry("google-mobile-ads", [{ key: "GADApplicationIdentifier", reason: "crash", guideline: "2.1" }])],
      guidelines
    );
    const { checks } = evaluateRules(profile, b);
    expect(checks.filter((c) => c.rule_id.startsWith("appstore.sdk-plist."))).toHaveLength(0);
  });

  it("two SDKs requiring the same key -> two checks (one per sdk id)", () => {
    const profile = iosProfile(
      { usage_descriptions: {} },
      {
        sdks: [
          sdk("core-location", { name: "Core Location" }),
          sdk("geolocator", { name: "Geolocator" }),
        ],
      }
    );
    const keyReq = [{ key: "NSLocationWhenInUseUsageDescription", reason: "loc", guideline: "5.1.1" }];
    const b = miniBundle(
      [templateRule()],
      [registryEntry("core-location", keyReq), registryEntry("geolocator", keyReq)],
      guidelines
    );
    const { checks } = evaluateRules(profile, b);
    expect(checks.find((c) => c.rule_id === "appstore.sdk-plist.core-location.NSLocationWhenInUseUsageDescription")).toBeDefined();
    expect(checks.find((c) => c.rule_id === "appstore.sdk-plist.geolocator.NSLocationWhenInUseUsageDescription")).toBeDefined();
  });

  it("synthesized rule is unverified when ios.plist is absent (unverified_if)", () => {
    const profile = baseProfile({ sdks: [sdk("healthkit", { name: "HealthKit", category: "health" })], ios: null });
    const b = miniBundle(
      [templateRule()],
      [registryEntry("healthkit", [{ key: "NSHealthShareUsageDescription", reason: "r", guideline: "5.1.1" }])],
      guidelines
    );
    const status = statusOf(b, profile, "appstore.sdk-plist.healthkit.NSHealthShareUsageDescription");
    expect(status).toBe("unverified");
  });

  it("synthesized rule passes when the required key is present", () => {
    const profile = iosProfile(
      { usage_descriptions: { NSHealthShareUsageDescription: "Reads workouts" } },
      { sdks: [sdk("healthkit", { name: "HealthKit", category: "health" })] }
    );
    const b = miniBundle(
      [templateRule()],
      [registryEntry("healthkit", [{ key: "NSHealthShareUsageDescription", reason: "r", guideline: "5.1.1" }])],
      guidelines
    );
    expect(statusOf(b, profile, "appstore.sdk-plist.healthkit.NSHealthShareUsageDescription")).toBe("pass");
  });

  it("falls back to parent guideline name when the requirement guideline is not in the index", () => {
    const profile = iosProfile(
      { usage_descriptions: {} },
      { sdks: [sdk("healthkit", { name: "HealthKit" })] }
    );
    const b = miniBundle(
      [templateRule()],
      [registryEntry("healthkit", [{ key: "NSHealthShareUsageDescription", reason: "r", guideline: "9.9.9" }])],
      {} // empty guideline index -> fallback to parent name
    );
    const { checks } = evaluateRules(profile, b);
    const c = checks.find((c) => c.rule_id === "appstore.sdk-plist.healthkit.NSHealthShareUsageDescription");
    expect(c?.guideline_number).toBe("9.9.9");
    // finding carries the fallback name
    const { findings } = evaluateRules(profile, b);
    expect(findings[0].guideline_name).toBe("Data Collection and Storage");
  });
});

// ===========================================================================
// Deterministic ordering
// ===========================================================================

describe("deterministic output ordering", () => {
  it("checks sorted fail, unverified, pass, na; then severity high->info; then rule id", () => {
    const b = miniBundle([
      rule({ id: "z-pass", severity: "high", fail_if: { platform: "android" } }),
      rule({ id: "a-na", severity: "high", applies_if: { platform: "android" }, fail_if: { always: true } }),
      rule({ id: "m-fail-low", severity: "low", fail_if: { always: true } }),
      rule({ id: "b-fail-high", severity: "high", fail_if: { always: true } }),
      rule({ id: "a-fail-high", severity: "high", fail_if: { always: true } }),
      rule({ id: "u-unverified", severity: "medium", unverified_if: { always: true }, fail_if: { always: true } }),
    ]);
    const { checks } = evaluateRules(baseProfile(), b);
    expect(checks.map((c) => c.rule_id)).toEqual([
      "a-fail-high", // fail, high, id a<b
      "b-fail-high", // fail, high
      "m-fail-low", // fail, low
      "u-unverified", // unverified
      "z-pass", // pass
      "a-na", // na
    ]);
  });

  it("findings sorted high->info then rule id", () => {
    const b = miniBundle([
      rule({ id: "low", severity: "low", fail_if: { always: true } }),
      rule({ id: "high-b", severity: "high", fail_if: { always: true } }),
      rule({ id: "high-a", severity: "high", fail_if: { always: true } }),
      rule({ id: "info", severity: "info", fail_if: { always: true } }),
    ]);
    const { findings } = evaluateRules(baseProfile(), b);
    expect(findings.map((f) => f.rule_id)).toEqual(["high-a", "high-b", "low", "info"]);
  });

  it("is stable across repeated evaluation", () => {
    const b = miniBundle([
      rule({ id: "r1", fail_if: { always: true } }),
      rule({ id: "r2", fail_if: { platform: "android" } }),
    ]);
    const a = evaluateRules(baseProfile(), b);
    const c = evaluateRules(baseProfile(), b);
    expect(a).toEqual(c);
  });
});
