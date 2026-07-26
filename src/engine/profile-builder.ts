// Profile builder: assembles the canonical AppProfile from the outputs of the
// individual extractors, the SDK registry match, and a source-signal scan.
// Pure and synchronous - all filesystem work happens in the extractors and in
// the orchestrator (index.ts); this module only shapes and derives.

import type { TechStack, TechStackResult } from "../types/report.js";
import type {
  AppProfile,
  Capability,
  EcosystemDeps,
  ProfileSDK,
  SDKRegistryEntry,
} from "./types.js";
import type { IosPlistExtraction } from "./extractors/ios-plist.js";
import type { IosEntitlementsExtraction } from "./extractors/ios-entitlements.js";
import type { IosPrivacyManifestExtraction } from "./extractors/ios-privacy-manifest.js";
import type { AndroidManifestExtraction } from "./extractors/android-manifest.js";
import type { GradleTargetsExtraction } from "./extractors/gradle-targets.js";
import type { EvidenceMap } from "./extractors/shared.js";

// ===========================================================================
// Source signal scanning
// ===========================================================================

export type SignalKey =
  | "restore_purchases"
  | "account_deletion"
  | "account_creation"
  | "privacy_policy_link"
  | "external_checkout_url"
  | "webview"
  | "ugc_surface"
  | "moderation_controls";

/** Where a signal matched. Drives evidence attribution and AI corpus selection. */
export interface SignalHit {
  path: string;
  signal: SignalKey;
  /** Character offset of the match within the file. */
  index: number;
}

export interface SignalScanInput {
  files: { path: string; content: string }[];
  /**
   * Whether `files` is the COMPLETE source corpus. When false, a signal that
   * was not found resolves to undefined ("unknown") rather than false, because
   * the evidence may simply live in a file we never read.
   *
   * Defaults to true: every existing caller passes a corpus it believes whole.
   */
  coverageComplete?: boolean;
}

export interface SourceSignals {
  // undefined = unknown (partial coverage). See AppProfile["signals"].
  restore_purchases_found?: boolean;
  account_deletion_found?: boolean;
  privacy_policy_link_found?: boolean;
  external_checkout_url_found?: boolean;
  account_creation_found?: boolean;
  ugc_surface_found?: boolean;
  moderation_controls_found?: boolean;
  webview_ratio?: number;
  webview_files: number;
  scanned_files: number;
  source_chars: number;
  coverage_complete: boolean;
  /** Engine-internal. NOT serialized into AppProfile. */
  hits: SignalHit[];
}

// Signal patterns. Case-sensitivity is deliberate per pattern:
//   - restore / account-creation are code identifiers (camelCase) -> case-sensitive.
//   - deletion / privacy-policy / external-checkout are prose or URLs -> case-insensitive (i).
//   - webview refs are framework/type identifiers -> case-sensitive.
const RESTORE_RE =
  /restorePurchases|restoreCompletedTransactions|restoreTransactions|queryPurchasesAsync|\brestore\s*\(\s*\)/;
// Deliberately does NOT include a loose `account.{0,20}delet` proximity clause.
// Now that the scan covers the whole corpus rather than a curated slice, that
// clause matched dead constants, admin-only endpoints and commented-out code,
// which would report a delete flow as present when the UI has no such button.
// A false "deletion exists" is worse than the false positive it replaced.
// `(?![a-z])` rather than `\b` so camelCase continuations still match
// (purgeAccountAndDeleteData) while unrelated longer words do not
// (deleteUsername, removeAccountingEntry).
const ACCOUNT_DELETION_RE =
  /\b(?:delete|remove|close|destroy|purge)(?:My)?(?:Account|User|Profile)s?(?![a-z])|\baccountDeletion\b|["'`][^"'`]{0,20}[Dd]elete (?:my )?[Aa]ccount/;
const ACCOUNT_CREATION_RE = /createAccount|createUser|signUp|register(?:User|Account|WithEmail)/;
const PRIVACY_POLICY_RE = /privacy[\s_-]?policy/i;
const EXTERNAL_CHECKOUT_RE =
  /checkout\.stripe\.com|buy\.stripe\.com|paypal\.com|lemonsqueezy|gumroad|paddle\.com/i;
const WEBVIEW_RE =
  /WKWebView|UIWebView|webview_flutter|react-native-webview|InAppWebView|android\.webkit\.WebView/;

// UGC detection is two-factor by design: a content VERB bound to a social
// NOUN, or a high-precision social identifier. Bare `comment|report|block|
// share|feed` words are excluded - a naive OR of those matched 85 of 263 files
// (32%) on a real app, which is indistinguishable from noise.
//
// The verb-to-noun gap allows an infix so domain-specific names still match
// (addSharedFlashCardComment). `Message` is deliberately paired only with
// post|publish|upload|submit|share and never with add|send|create, because
// `addMessage`/`sendMessage` is how every AI-chat app writes to its own
// conversation cache; flagging those would put a high-severity 1.2 finding on
// every chatbot. Bare `share` + arbitrary noun is likewise excluded: it is
// indistinguishable from an OS share-sheet call.
// The trailing (?![a-z]) is what keeps the infix safe: getPostalCode and
// postRequest are rejected because the noun must end at a camelCase boundary.
const UGC_SURFACE_RE =
  /\b(?:add|post|publish|submit|create|edit|update|delete|fetch|load|get)[A-Za-z]{0,24}(?:Comment|Reply|Thread|Discussion|Post)s?(?![a-z])|\b(?:post|publish|upload|submit|share)(?:Review|Story|Photo|Video|Content|Message)s?(?![a-z])|\buserGenerated\b|(?:[Ff]eed|[Tt]imeline|[Cc]ommunity)(?:ViewModel|Controller|Bloc|Provider|Repository|Service|Screen|Page|View)s?(?![a-z])|\bcommentCount\b|\blikeCount\b|\bupvote|\bsharedBy\b/;

// Moderation affordances Apple looks for under 1.2: report content, block
// users, filter objectionable material. Compound identifiers only - a bare
// `report` matches crashReport/bugReport, a bare `block` matches
// blockSize/blockchain, and even the word "moderation" shows up in ordinary
// prose. A false match here makes a real 1.2 violation silently PASS, which is
// the worst outcome this engine can produce, so the bar is deliberately high.
// report/flag allows an infix (reportSharedFlashCardSet) but the negative
// lookahead keeps crash-reporting out: reportErrorToUser would otherwise
// satisfy 1.2 and let an unmoderated app pass.
const MODERATION_RE =
  /\b(?:report|flag)(?!Error|Crash|Bug|Exception|Issue|Analytics|Event)[A-Za-z]{0,24}(?:Content|Post|Comment|User|Abuse|Message|Reason|Item|Set|Author)s?(?![a-z])|\b(?:block|mute|ban|unblock)(?:ed)?(?:User|Author|Account|Member|List|Comment|Set)s?(?![a-z])|(?:Block|Unblock|Mute)(?:ed)?(?:User|Author|Account|Member|List|Comment|Set)s?(?![a-z])|[Cc]ontentReport|[Rr]eportReason|\bmoderate(?:Comment|Post|Content|User|Item)|[Cc]ontentModeration\b|[Mm]oderationQueue\b/;

/** Rounds to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The once-per-signal detectors, in the order they appear in SourceSignals. */
const ONESHOT_SIGNALS: { key: SignalKey; re: RegExp }[] = [
  { key: "restore_purchases", re: RESTORE_RE },
  { key: "account_deletion", re: ACCOUNT_DELETION_RE },
  { key: "account_creation", re: ACCOUNT_CREATION_RE },
  { key: "privacy_policy_link", re: PRIVACY_POLICY_RE },
  { key: "external_checkout_url", re: EXTERNAL_CHECKOUT_RE },
];

/**
 * Scans already-read source files for behavioral signals.
 *
 * Coverage handling is deliberately ASYMMETRIC. A positive is coverage
 * independent: finding `deleteAccount` proves deletion exists no matter how
 * much else you skipped. A negative is not: "not found" only means "absent"
 * if you actually looked everywhere. So `found ? true : complete ? false :
 * <omitted>`, and an omitted key resolves to `unverified` in the rule engine
 * rather than to a violation.
 */
export function scanSourceSignals(input: SignalScanInput): SourceSignals {
  const complete = input.coverageComplete ?? true;
  const found = new Map<SignalKey, SignalHit>();
  const hits: SignalHit[] = [];
  let webviewFiles = 0;
  let sourceChars = 0;

  for (const { path, content } of input.files) {
    sourceChars += content.length;

    for (const { key, re } of ONESHOT_SIGNALS) {
      // First hit wins: it becomes the evidence file for this signal. Skipping
      // already-found signals also keeps a full-corpus scan cheap.
      if (found.has(key)) continue;
      const m = re.exec(content);
      if (m) {
        const hit: SignalHit = { path, signal: key, index: m.index };
        found.set(key, hit);
        hits.push(hit);
      }
    }

    // UGC and moderation are evaluated together, per file, because moderation
    // only counts when it is attached to user-generated content. A standalone
    // `reportMessage` in a chat app's support dialog is a support ticket, not
    // 1.2 moderation, and letting it satisfy the check would make a genuinely
    // unmoderated UGC app PASS. Requiring co-occurrence errs toward reporting
    // a 1.2 risk that turns out to be handled, which is the safe direction.
    const ugc = UGC_SURFACE_RE.exec(content);
    if (ugc && !found.has("ugc_surface")) {
      const hit: SignalHit = { path, signal: "ugc_surface", index: ugc.index };
      found.set("ugc_surface", hit);
      hits.push(hit);
    }
    if (ugc && !found.has("moderation_controls")) {
      const mod = MODERATION_RE.exec(content);
      if (mod) {
        const hit: SignalHit = { path, signal: "moderation_controls", index: mod.index };
        found.set("moderation_controls", hit);
        hits.push(hit);
      }
    }

    const wv = WEBVIEW_RE.exec(content);
    if (wv) {
      webviewFiles += 1;
      hits.push({ path, signal: "webview", index: wv.index });
    }
  }

  const scannedFiles = input.files.length;
  const tri = (key: SignalKey): boolean | undefined =>
    found.has(key) ? true : complete ? false : undefined;

  // Build with conditional spread so an unknown signal is a genuinely ABSENT
  // property (hasOwnProperty === false), not a property set to undefined.
  // resolveFact distinguishes the two, and only "missing" is unambiguous.
  const put = (name: string, key: SignalKey) => {
    const v = tri(key);
    return v === undefined ? {} : { [name]: v };
  };

  return {
    ...put("restore_purchases_found", "restore_purchases"),
    ...put("account_deletion_found", "account_deletion"),
    ...put("account_creation_found", "account_creation"),
    ...put("privacy_policy_link_found", "privacy_policy_link"),
    ...put("external_checkout_url_found", "external_checkout_url"),
    ...put("ugc_surface_found", "ugc_surface"),
    ...put("moderation_controls_found", "moderation_controls"),
    ...(complete ? { webview_ratio: round2(webviewFiles / Math.max(scannedFiles, 1)) } : {}),
    webview_files: webviewFiles,
    scanned_files: scannedFiles,
    source_chars: sourceChars,
    coverage_complete: complete,
    hits,
  };
}

// ===========================================================================
// Profile assembly
// ===========================================================================

export interface BuildProfileInput {
  rootDir: string;
  stackResult: TechStackResult;
  appConfig: {
    app_name: string | null;
    bundle_id: string | null;
    version?: string | null;
    min_ios_version?: string | null;
    min_android_sdk?: string | null;
  };
  deps: EcosystemDeps;
  sdks: ProfileSDK[];
  registry: SDKRegistryEntry[];
  ios: IosPlistExtraction | null;
  entitlements: IosEntitlementsExtraction | null;
  privacyManifest: IosPrivacyManifestExtraction | null;
  android: AndroidManifestExtraction | null;
  gradleTargets: GradleTargetsExtraction | null;
  signals: SourceSignals | null;
  /** Corpus coverage behind `signals`, surfaced in profile.stats. */
  coverage?: { discovered: number; complete: boolean };
  generatedAt: string;
}

/** Maps a signal key to the `signals.*` fact path rules reference. */
const SIGNAL_FACT_PATH: Record<SignalKey, string | null> = {
  restore_purchases: "signals.restore_purchases_found",
  account_deletion: "signals.account_deletion_found",
  account_creation: "signals.account_creation_found",
  privacy_policy_link: "signals.privacy_policy_link_found",
  external_checkout_url: "signals.external_checkout_url_found",
  ugc_surface: "signals.ugc_surface_found",
  moderation_controls: "signals.moderation_controls_found",
  webview: "signals.webview_ratio",
};

/**
 * Turns the first hit for each found signal into an evidence entry.
 *
 * This is what finally populates `ReviewFinding.file` for signal-driven rules:
 * firstEvidenceFile() already walks each rule's `evidence_facts`, and those
 * rules already list their `signals.*` paths there, so no rule change is
 * needed. A signal-based claim is now auditable instead of asserted.
 */
function signalEvidence(signals: SourceSignals | null): EvidenceMap {
  const evidence: EvidenceMap = {};
  if (!signals) return evidence;
  for (const hit of signals.hits) {
    const factPath = SIGNAL_FACT_PATH[hit.signal];
    if (!factPath || evidence[factPath]) continue;
    evidence[factPath] = { file: hit.path, detail: "source scan" };
  }
  return evidence;
}

/** Maps an android permission (full or short name) to its short suffix. */
function permissionShortName(permission: string): string {
  const idx = permission.lastIndexOf(".");
  return idx >= 0 ? permission.slice(idx + 1) : permission;
}

/** Best-effort dependency-manifest file for a matched coordinate (evidence hint). */
function sdkOriginFile(coordinate: string, stack: TechStack): string | null {
  const ecosystem = coordinate.slice(0, coordinate.indexOf(":"));
  switch (ecosystem) {
    case "npm":
      return "package.json";
    case "pub":
      return "pubspec.yaml";
    case "pods":
      return stack === "swift" ? "Podfile" : "ios/Podfile";
    case "spm":
      return "Package.swift";
    case "gradle":
      return stack === "kotlin" ? "app/build.gradle" : "android/app/build.gradle";
    case "nuget":
      return "*.csproj";
    case "upm":
      return "Packages/manifest.json";
    default:
      // ios_imports / android_imports: matched from source, not a manifest.
      return null;
  }
}

/**
 * Derives the app's capabilities from every available evidence source, then
 * dedupes and sorts. Union across: matched-SDK `implies`, entitlements, the
 * privacy manifest, source signals, android permissions, and iOS usage
 * descriptions.
 */
function deriveCapabilities(input: BuildProfileInput): Capability[] {
  const caps = new Set<Capability>();

  // 1. From matched SDKs: union of each matched entry's `implies`.
  const registryById = new Map<string, SDKRegistryEntry>(
    input.registry.map((entry) => [entry.id, entry])
  );
  for (const sdk of input.sdks) {
    const entry = registryById.get(sdk.id);
    for (const cap of entry?.implies ?? []) caps.add(cap);
  }

  // 2. Entitlements.
  const ent = input.entitlements?.entitlements;
  if (ent) {
    if (ent.sign_in_with_apple) caps.add("sign_in_with_apple");
    if (ent.aps_environment !== null) caps.add("push_notifications");
    if (ent.healthkit) caps.add("health");
  }

  // 3. Background modes are NOT derived into capabilities: rules CHECK
  //    background_modes against capabilities (e.g. background-location vs the
  //    background_location capability). Deriving the capability from the mode
  //    would make those rules tautological. So: intentionally nothing here.

  // 4. Privacy manifest: an explicit tracking=true declaration.
  if (input.privacyManifest?.privacy_manifest.tracking === true) {
    caps.add("tracking");
  }

  // 5. Source signals. Explicit `=== true`: these are now tri-state, and an
  //    unknown signal must not derive a capability.
  const signals = input.signals;
  if (signals) {
    if (signals.account_creation_found === true) caps.add("account_creation");
    if (signals.account_deletion_found === true) caps.add("account_deletion");
    if (signals.external_checkout_url_found === true) caps.add("external_payment");
    // UGC used to be derivable ONLY from a matched third-party SDK (Stream,
    // Agora and friends), so a hand-rolled sharing/commenting feature was
    // invisible to guideline 1.2 no matter how large it was.
    if (signals.ugc_surface_found === true) caps.add("ugc");
    if (signals.webview_ratio !== undefined && signals.webview_ratio >= 0.5) {
      caps.add("webview_heavy");
    }
  }

  // 6. Android permissions.
  for (const permission of input.android?.android.permissions ?? []) {
    switch (permissionShortName(permission)) {
      case "ACCESS_FINE_LOCATION":
      case "ACCESS_COARSE_LOCATION":
        caps.add("location");
        break;
      case "CAMERA":
        caps.add("camera");
        break;
      case "RECORD_AUDIO":
        caps.add("microphone");
        break;
      case "ACTIVITY_RECOGNITION":
      case "BODY_SENSORS":
        caps.add("health");
        break;
      case "READ_CONTACTS":
        caps.add("contacts");
        break;
      default:
        break;
    }
  }

  // 7. iOS usage descriptions (presence of the key = the app declares that use).
  const usage = input.ios?.plist?.usage_descriptions;
  if (usage) {
    const has = (key: string) => Object.prototype.hasOwnProperty.call(usage, key);
    const keys = Object.keys(usage);
    if (has("NSCameraUsageDescription")) caps.add("camera");
    if (has("NSMicrophoneUsageDescription")) caps.add("microphone");
    if (keys.some((k) => k.startsWith("NSLocationWhenInUse") || k.startsWith("NSLocationAlways"))) {
      caps.add("location");
    }
    if (has("NSContactsUsageDescription")) caps.add("contacts");
    if (keys.some((k) => k.startsWith("NSPhotoLibrary"))) caps.add("photos");
    if (has("NSHealthShareUsageDescription") || has("NSHealthUpdateUsageDescription")) {
      caps.add("health");
    }
    if (keys.some((k) => k.startsWith("NSBluetooth"))) caps.add("bluetooth");
    if (has("NSUserTrackingUsageDescription")) caps.add("tracking");
  }

  return Array.from(caps).sort();
}

/** Merges every extractor's evidence map plus a best-effort `sdks` origin. */
function mergeEvidence(input: BuildProfileInput): AppProfile["evidence"] {
  const evidence: EvidenceMap = {};
  const sources: (EvidenceMap | undefined)[] = [
    signalEvidence(input.signals),
    input.ios?.evidence,
    input.entitlements?.evidence,
    input.privacyManifest?.evidence,
    input.android?.evidence,
    input.gradleTargets?.evidence,
  ];
  for (const source of sources) {
    if (source) Object.assign(evidence, source);
  }

  // `sdks` evidence -> the dependency manifest the first matched coordinate
  // came from (cheap best-effort; import-matched SDKs have no manifest).
  const firstCoordinate = input.sdks[0]?.matched_coordinates[0];
  if (firstCoordinate) {
    const file = sdkOriginFile(firstCoordinate, input.stackResult.stack);
    if (file) evidence["sdks"] = { file, detail: "dependency manifest" };
  }

  return evidence;
}

/**
 * Builds the canonical AppProfile. The iOS/Android sub-objects are null when
 * the corresponding extractors were not run (the orchestrator gates them by
 * platform), which is what lets tri-state fact resolution report UNKNOWN
 * rather than a false MISSING for an unscanned platform.
 */
export function buildAppProfile(input: BuildProfileInput): AppProfile {
  const hasIos =
    input.ios !== null || input.entitlements !== null || input.privacyManifest !== null;

  const ios: AppProfile["ios"] = hasIos
    ? {
        plist_source: input.ios?.plist_source ?? "none",
        plist: input.ios?.plist ?? null,
        entitlements: input.entitlements?.entitlements ?? null,
        privacy_manifest: input.privacyManifest?.privacy_manifest ?? null,
      }
    : null;

  const android: AppProfile["android"] = input.android ? input.android.android : null;

  // Copy only the keys the scan actually resolved. An unresolved signal must
  // stay ABSENT from the profile (not present-as-null) so resolveFact reports
  // `missing` and the rule engine yields "unverified". `null` would work too
  // (it resolves to unknown), but absence is the contract-consistent shape and
  // is exactly what an older CLI's profile looks like.
  const SIGNAL_FIELDS = [
    "restore_purchases_found",
    "account_deletion_found",
    "privacy_policy_link_found",
    "external_checkout_url_found",
    "ugc_surface_found",
    "moderation_controls_found",
    "webview_ratio",
  ] as const;

  const signals: AppProfile["signals"] = {};
  if (input.signals) {
    const src = input.signals as unknown as Record<string, unknown>;
    for (const field of SIGNAL_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(src, field)) {
        (signals as Record<string, unknown>)[field] = src[field];
      }
    }
  } else {
    // No source was scanned at all. Explicit nulls say "present but
    // unresolvable", which also resolves to unverified.
    for (const field of SIGNAL_FIELDS) {
      (signals as Record<string, unknown>)[field] = null;
    }
  }

  return {
    schema_version: 1,
    generated_at: input.generatedAt,
    stack: input.stackResult.stack,
    stack_label: input.stackResult.label,
    platforms: input.stackResult.platforms,
    app: {
      name: input.appConfig.app_name,
      bundle_id: input.appConfig.bundle_id,
      version: input.appConfig.version ?? null,
      min_ios_version: input.appConfig.min_ios_version ?? null,
      min_android_sdk: input.gradleTargets?.min_android_sdk ?? null,
      target_android_sdk: input.gradleTargets?.target_android_sdk ?? null,
    },
    sdks: input.sdks,
    raw_dependencies: input.deps,
    ios,
    android,
    capabilities: deriveCapabilities(input),
    signals,
    evidence: mergeEvidence(input),
    stats: {
      files_scanned: input.signals?.scanned_files ?? 0,
      source_chars_read: input.signals?.source_chars ?? 0,
      ...(input.coverage
        ? {
            files_discovered: input.coverage.discovered,
            coverage_complete: input.coverage.complete,
          }
        : {}),
    },
  };
}
