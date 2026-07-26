// MIRROR OF forvibeapp src/lib/review-engine/schema.ts - keep both files in sync when either changes.
//
// Hand-mirrored copy of the canonical review-engine schema. Types only (no
// zod - not a CLI dependency). Names and shapes must stay byte-faithful to
// the canonical file so the CLI's AppProfile output can be consumed by the
// forvibeapp rule engine without translation.
//
// Rule evaluation order (the CLI engine implements this; documented here so
// both implementations stay in sync):
//
//   1. `applies_if` evaluates false  -> status "na" (rule does not apply).
//   2. else `unverified_if` evaluates true -> status "unverified" (needs the
//      AI pass or a human; static analysis cannot decide).
//   3. else `fail_if` evaluates true -> status "fail" (+ finding emitted).
//   4. else -> status "pass".
//
// A predicate whose fact path resolves to `null` (or to an object that is
// itself `null`, e.g. `ios.plist` absent) is "unknown", not false. A
// Condition whose outcome depends on at least one unknown predicate (and
// isn't already decided by the other, known predicates) resolves the
// containing check to "unverified" rather than confidently "pass" or "fail".
// This is why most rules pair a `fail_if` with an `unverified_if` that
// detects the "we don't have enough data" case explicitly.

// =============================================
// Store / capability / SDK vocabularies
// =============================================

export type StoreId = "appstore" | "play";

export type Capability =
  | "push_notifications" | "iap" | "subscriptions" | "ads" | "tracking"
  | "health" | "location" | "camera" | "microphone" | "contacts" | "photos"
  | "bluetooth" | "background_audio" | "background_location"
  | "account_creation" | "account_deletion" | "sign_in_with_apple"
  | "third_party_login" | "webview_heavy" | "ugc" | "external_payment"
  | "kids_category" | "ai_generated_content" | "gambling" | "crypto";

export type SDKCategory =
  | "ads" | "analytics" | "attribution" | "auth" | "payments" | "push"
  | "crash" | "social" | "maps" | "ai" | "cloud" | "media" | "support"
  | "health" | "other";

// =============================================
// App profile (produced by the codebase scanner; consumed by the rule engine)
// =============================================

export interface EcosystemDeps {
  npm: string[]; pub: string[]; pods: string[]; spm: string[];
  gradle: string[];          // "artifact" or "group:artifact"
  nuget: string[]; upm: string[];
  ios_imports: string[]; android_imports: string[];
}

export interface ProfileSDK {
  id: string; name: string; category: SDKCategory;
  matched_coordinates: string[];   // e.g. ["pods:Google-Mobile-Ads-SDK"]
  data_collection: string[];
  flags: { att_required?: boolean; requires_privacy_manifest?: boolean; advertising?: boolean };
}

export interface AppProfile {
  schema_version: 1;
  generated_at: string;
  stack: string; stack_label: string;
  platforms: ("ios" | "android")[];
  app: {
    name: string | null; bundle_id: string | null; version: string | null;
    min_ios_version: string | null; min_android_sdk: number | null;
    target_android_sdk: number | null;
  };
  sdks: ProfileSDK[];
  raw_dependencies: EcosystemDeps;
  ios: {
    plist_source: "plist_file" | "pbxproj_infoplist_keys" | "expo_config" | "merged" | "none";
    plist: {
      usage_descriptions: Record<string, string | null>; // key -> value; null = present but empty or unresolved $(VAR)
      background_modes: string[];
      ats_allows_arbitrary_loads: boolean | null;        // null = ATS dict absent (kept non-optional: eq-true then resolves false -> pass, the right outcome)
      // Omitted-vs-null contract for the two optional scalars below:
      //   property OMITTED       = source key genuinely absent (definitive absence)
      //   property present, null = key present but value unresolvable (unresolved $(VAR) or unparseable)
      //   concrete value         = declared
      gad_application_identifier?: string | null;
      sk_ad_network_count: number;
      non_exempt_encryption?: boolean | null;
      required_device_capabilities: string[];
      other_keys: string[];                              // names only
    } | null;
    entitlements: {
      aps_environment: string | null; associated_domains: string[];
      healthkit: boolean; sign_in_with_apple: boolean; app_groups: string[];
      keys: string[];
    } | null;
    privacy_manifest: {
      app_manifest_present: boolean;
      collected_data_types: string[]; accessed_api_types: string[];
      tracking: boolean | null; tracking_domains: string[];
      sdk_manifests_found: number;
    } | null;
  } | null;
  android: {
    manifest_found: boolean; permissions: string[];
    exported_components: number; queries_declared: boolean;
  } | null;
  capabilities: Capability[];
  // Omitted-vs-value contract, same shape as the iOS plist scalars above:
  //   property OMITTED = the scan could not determine this (partial coverage)
  //                      -> rules resolve `absent` and yield "unverified"
  //   false            = scanned the WHOLE corpus and genuinely did not find it
  //   true             = found (coverage-independent; a hit is a hit)
  // Emitting a confident `false` from a partial scan is what produced false
  // "account deletion missing" / "no privacy policy" violations.
  signals: {
    restore_purchases_found?: boolean | null;
    account_deletion_found?: boolean | null;
    privacy_policy_link_found?: boolean | null;
    external_checkout_url_found?: boolean | null;
    ugc_surface_found?: boolean | null;
    moderation_controls_found?: boolean | null;
    webview_ratio?: number | null;
  };
  evidence: Record<string, { file: string; detail?: string }>;
  stats: {
    files_scanned: number;
    source_chars_read: number;
    /** Source files the walker found. Denominator for files_scanned. */
    files_discovered?: number;
    /** False when a budget/limit stopped the scan short of the whole corpus. */
    coverage_complete?: boolean;
    /** Files actually placed in the AI prompt (a subset of files_scanned). */
    ai_context_files?: number;
  };
}

// =============================================
// Rule conditions
// =============================================

export type CheckStatus = "pass" | "fail" | "na" | "unverified";

export type Predicate =
  | { always: true }                                     // used for rules that always need AI/manual verification
  | { sdk: string }
  | { sdk_category: SDKCategory }
  | { sdk_flag: "att_required" | "requires_privacy_manifest" | "advertising" }
  | { capability: Capability }
  | { platform: "ios" | "android" }
  | { fact: string;
      op: "exists" | "absent" | "eq" | "neq" | "gte" | "lte" | "includes" | "not_includes" | "matches";
      value?: string | number | boolean };

export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | Predicate;

// =============================================
// Rules / rule packs
// =============================================

export type RuleSeverity = "high" | "medium" | "low" | "info";
export type ReviewCategory = "safety" | "performance" | "business" | "design" | "legal" | "common-pitfalls";

export interface Rule {
  id: string;                          // "appstore.att-usage-description-missing"
  store: StoreId;
  guideline: { number: string; name: string };
  severity: RuleSeverity;
  category: ReviewCategory;
  title: string;
  description: string;                 // may contain {{sdk_names}} and {{evidence}} placeholders
  user_impact: string;
  fix: string;
  autofix_hint?: string;
  template?: "sdk_required_plist_keys"; // engine expands this rule per SDK registry `requires.ios_plist_keys` entry
  applies_if?: Condition;              // evaluates false -> check status "na"
  unverified_if?: Condition;           // evaluates true (while applicable) -> "unverified"
  fail_if: Condition;                  // evaluates true (applicable, verified) -> "fail" + finding
  evidence_facts: string[];            // AppProfile fact paths to surface as evidence
  related_story_ids?: string[];
  tags?: string[];
}

export interface RulePack {
  schema_version: 1; store: StoreId;
  version: string;                     // semver; MUST be bumped when content changes
  updated_at: string;                  // ISO date
  rules: Rule[];
}

// =============================================
// SDK registry
// =============================================

export interface SDKRegistryEntry {
  id: string; name: string; vendor?: string; category: SDKCategory;
  match: {
    pub?: string[]; npm?: string[]; pods?: string[];
    spm?: string[];                    // repo slug from Package.swift / pbxproj URL, e.g. "purchases-ios"
    gradle?: string[];                 // "group:artifact" or bare artifact; "*" suffix = prefix match
    nuget?: string[]; upm?: string[];
    ios_imports?: string[]; android_imports?: string[]; // package prefixes
  };
  data_collection: string[];
  flags: { att_required?: boolean; requires_privacy_manifest?: boolean; advertising?: boolean };
  implies?: Capability[];              // capabilities this SDK's presence implies (e.g. revenuecat -> ["iap","subscriptions"])
  requires?: {
    ios_plist_keys?: { key: string; reason: string; guideline: string }[];
    ios_entitlements?: string[];
    android_permissions?: string[];
  };
  notes?: string;
  stories?: string[];
}

export interface SDKRegistry {
  schema_version: 1; version: string; updated_at: string;
  sdks: SDKRegistryEntry[];
}

// =============================================
// Rejection stories (RAG corpus)
// =============================================

export interface RejectionStory {
  id: string;
  store: StoreId;                      // NEW field, "appstore" for all existing
  guidelineNumber: string; guidelineName: string;
  category: ReviewCategory;
  rejectionReason: string; whatDeveloperDid: string; whatAppleSaid: string;
  fix: string; outcome: string;
  keywords: string[]; behavioralSignals: string[];
  year?: number;
}

// =============================================
// Guideline index
// =============================================

export interface GuidelineIndexEntry { name: string; summary: string; section: string; }
export type GuidelineIndex = Record<string, GuidelineIndexEntry>; // key = guideline number e.g. "5.1.2"

// =============================================
// Review checks (engine output)
// =============================================

export interface ReviewCheck {
  rule_id: string; title: string; status: CheckStatus;
  severity: RuleSeverity; guideline_number: string;
  evidence?: string; finding_id?: string;
}

// =============================================
// Rulepack bundle (mirrors forvibeapp src/lib/review-engine/bundle.ts)
// =============================================

export interface RulepackBundle {
  schema_version: 1;
  store: StoreId;
  version: string;
  updated_at: string;
  rules: Rule[];
  sdk_registry: SDKRegistryEntry[];
  stories: RejectionStory[];
  guidelines: GuidelineIndex;
}
