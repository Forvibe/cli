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

export interface SignalScanInput {
  files: { path: string; content: string }[];
}

export interface SourceSignals {
  restore_purchases_found: boolean;
  account_deletion_found: boolean;
  privacy_policy_link_found: boolean;
  external_checkout_url_found: boolean;
  webview_ratio: number;
  account_creation_found: boolean;
  webview_files: number;
  scanned_files: number;
  source_chars: number;
}

// Signal patterns. Case-sensitivity is deliberate per pattern:
//   - restore / account-creation are code identifiers (camelCase) -> case-sensitive.
//   - deletion / privacy-policy / external-checkout are prose or URLs -> case-insensitive (i).
//   - webview refs are framework/type identifiers -> case-sensitive.
const RESTORE_RE =
  /restorePurchases|restoreCompletedTransactions|restoreTransactions|queryPurchasesAsync|\brestore\s*\(\s*\)/;
const ACCOUNT_DELETION_RE = /deleteAccount|removeAccount|deleteUser|closeAccount|account.{0,20}delet/i;
const ACCOUNT_CREATION_RE = /createAccount|createUser|signUp|register(?:User|Account|WithEmail)/;
const PRIVACY_POLICY_RE = /privacy[\s_-]?policy/i;
const EXTERNAL_CHECKOUT_RE =
  /checkout\.stripe\.com|buy\.stripe\.com|paypal\.com|lemonsqueezy|gumroad|paddle\.com/i;
const WEBVIEW_RE =
  /WKWebView|UIWebView|webview_flutter|react-native-webview|InAppWebView|android\.webkit\.WebView/;

/** Rounds to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Scans already-read source files for behavioral signals. Always returns
 * concrete booleans and counts; the "we didn't scan any source" case is
 * represented by passing `null` for the signals input to buildAppProfile.
 */
export function scanSourceSignals(input: SignalScanInput): SourceSignals {
  let restore = false;
  let deletion = false;
  let creation = false;
  let privacyPolicy = false;
  let externalCheckout = false;
  let webviewFiles = 0;
  let sourceChars = 0;

  for (const { content } of input.files) {
    sourceChars += content.length;
    if (!restore && RESTORE_RE.test(content)) restore = true;
    if (!deletion && ACCOUNT_DELETION_RE.test(content)) deletion = true;
    if (!creation && ACCOUNT_CREATION_RE.test(content)) creation = true;
    if (!privacyPolicy && PRIVACY_POLICY_RE.test(content)) privacyPolicy = true;
    if (!externalCheckout && EXTERNAL_CHECKOUT_RE.test(content)) externalCheckout = true;
    if (WEBVIEW_RE.test(content)) webviewFiles += 1;
  }

  const scannedFiles = input.files.length;

  return {
    restore_purchases_found: restore,
    account_deletion_found: deletion,
    privacy_policy_link_found: privacyPolicy,
    external_checkout_url_found: externalCheckout,
    webview_ratio: round2(webviewFiles / Math.max(scannedFiles, 1)),
    account_creation_found: creation,
    webview_files: webviewFiles,
    scanned_files: scannedFiles,
    source_chars: sourceChars,
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
  generatedAt: string;
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

  // 5. Source signals.
  const signals = input.signals;
  if (signals) {
    if (signals.account_creation_found) caps.add("account_creation");
    if (signals.account_deletion_found) caps.add("account_deletion");
    if (signals.webview_ratio >= 0.5) caps.add("webview_heavy");
    if (signals.external_checkout_url_found) caps.add("external_payment");
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

  const signals: AppProfile["signals"] = input.signals
    ? {
        restore_purchases_found: input.signals.restore_purchases_found,
        account_deletion_found: input.signals.account_deletion_found,
        privacy_policy_link_found: input.signals.privacy_policy_link_found,
        external_checkout_url_found: input.signals.external_checkout_url_found,
        webview_ratio: input.signals.webview_ratio,
      }
    : {
        restore_purchases_found: null,
        account_deletion_found: null,
        privacy_policy_link_found: null,
        external_checkout_url_found: null,
        webview_ratio: null,
      };

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
    },
  };
}
