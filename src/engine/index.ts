// Static review engine orchestrator. Wires the raw dependency collector, the
// SDK registry matcher, the platform-gated artifact extractors, the source
// signal scan, the profile builder, and the rule evaluator into one
// synchronous, network-free, AI-free entry point.

import { join } from "node:path";
import { scanDirectory, readFileSafe } from "../utils/file-scanner.js";
import { collectRawDependencies } from "../analyzers/sdk-scanner.js";
import { matchSDKs } from "./registry.js";
import { extractIosPlist } from "./extractors/ios-plist.js";
import { extractIosEntitlements } from "./extractors/ios-entitlements.js";
import { extractIosPrivacyManifest } from "./extractors/ios-privacy-manifest.js";
import { extractAndroidManifest } from "./extractors/android-manifest.js";
import { extractGradleTargets } from "./extractors/gradle-targets.js";
import { extractUnityProjectSettings } from "./extractors/unity.js";
import { findKmpLayout } from "./extractors/kmp.js";
import {
  buildAppProfile,
  scanSourceSignals,
  type SourceSignals,
} from "./profile-builder.js";
import { evaluateRules } from "./rules.js";
import type { TechStack, TechStackResult } from "../types/report.js";
import type { AppProfile, ReviewCheck, RulepackBundle } from "./types.js";
import type { ReviewFinding } from "../types/review.js";

export interface StaticEngineInput {
  rootDir: string;
  stackResult: TechStackResult;
  appConfig: {
    app_name: string | null;
    bundle_id: string | null;
    version?: string | null;
    min_ios_version?: string | null;
    min_android_sdk?: string | null;
  };
  bundle: RulepackBundle;
  /** Provided when the caller (review.ts) already read source files. */
  sourceFiles?: { path: string; content: string }[];
  /** Optional fixed timestamp for deterministic output; defaults to now. */
  generatedAt?: string;
}

export interface StaticEngineResult {
  profile: AppProfile;
  checks: ReviewCheck[];
  findings: ReviewFinding[];
}

// Source-file extensions per stack. Mirrors source-reader.ts's mapping WITHOUT
// its budget/priority logic (see brief) - the engine only needs raw content to
// regex for behavioral signals.
function extensionsForStack(stack: TechStack): string[] {
  switch (stack) {
    case "flutter":
      return [".dart"];
    case "swift":
      return [".swift", ".m", ".mm", ".h"];
    case "kotlin":
      return [".kt", ".kts"];
    case "expo":
    case "react-native":
    case "capacitor":
      return [".ts", ".tsx", ".js", ".jsx"];
    case "dotnet-maui":
      return [".cs", ".xaml"];
    case "unity":
      return [".cs"];
    case "kmp":
      return [".kt", ".kts", ".swift"];
    default:
      return [".ts", ".js", ".swift", ".dart", ".kt"];
  }
}

const SELF_SCAN_MAX_FILES = 300;
const SELF_SCAN_MAX_TOTAL_CHARS = 200 * 1024; // 200KB budget across all files

/**
 * Lightweight self-scan so the engine also works standalone (no caller-provided
 * source). Reads up to 300 source files or 200KB total, whichever comes first.
 */
function selfScanSource(
  rootDir: string,
  stack: TechStack
): { path: string; content: string }[] {
  const relPaths = scanDirectory(rootDir, {
    extensions: extensionsForStack(stack),
    maxDepth: 8,
    maxFiles: SELF_SCAN_MAX_FILES,
  });

  const files: { path: string; content: string }[] = [];
  let totalChars = 0;
  for (const rel of relPaths) {
    if (files.length >= SELF_SCAN_MAX_FILES || totalChars >= SELF_SCAN_MAX_TOTAL_CHARS) break;
    const content = readFileSafe(join(rootDir, rel));
    if (content === null) continue;
    files.push({ path: rel, content });
    totalChars += content.length;
  }
  return files;
}

/**
 * Runs the full static engine: collect deps -> match SDKs -> platform-gated
 * extractors -> source signals -> build profile -> evaluate rules.
 */
export function runStaticEngine(input: StaticEngineInput): StaticEngineResult {
  const { rootDir, stackResult, bundle } = input;
  const { stack, platforms } = stackResult;

  const deps = collectRawDependencies(rootDir, stack);
  const sdks = matchSDKs(deps, bundle.sdk_registry);

  const isIos = platforms.includes("ios");
  const isAndroid = platforms.includes("android");

  // KMP: the real iOS/Android artifacts live in dedicated module
  // directories, not at rootDir - locate them once and point the shared
  // extractors there. Falling back to rootDir when a module isn't found
  // keeps behavior sane for a malformed/partial KMP layout (the same
  // best-effort default every other stack already gets). Every other stack
  // leaves kmpLayout null, so iosRoot/androidRoot both equal rootDir and
  // behavior is byte-identical to before this change.
  const kmpLayout = stack === "kmp" ? findKmpLayout(rootDir) : null;
  const iosRoot = kmpLayout?.iosAppDir ?? rootDir;
  const androidRoot = kmpLayout?.androidModuleDir ?? rootDir;

  const ios = isIos ? extractIosPlist(iosRoot) : null;
  const entitlements = isIos ? extractIosEntitlements(iosRoot) : null;
  const privacyManifest = isIos ? extractIosPrivacyManifest(iosRoot) : null;
  const android = isAndroid ? extractAndroidManifest(androidRoot) : null;
  // gradle-targets: KMP needs the android module's OWN build.gradle(.kts)
  // for min/targetSdk, same reasoning as androidRoot above.
  const gradleTargets = isAndroid ? extractGradleTargets(androidRoot) : null;

  // Unity: ProjectSettings/ProjectSettings.asset (PlayerSettings) is the
  // only pre-build source of app identity - there is no Info.plist /
  // AndroidManifest.xml until the platform build actually runs, which is
  // exactly why the shared iOS/Android extractors above are expected to
  // find nothing for a Unity project (ios.plist / android stay null ->
  // rules correctly resolve "unverified" rather than a false pass/fail).
  // This only fills app-identity gaps the caller's appConfig left null; it
  // never overrides an explicit value the caller already supplied.
  let appConfig = input.appConfig;
  let extraEvidence: Record<string, { file: string; detail?: string }> | null = null;
  if (stack === "unity") {
    const unityExtraction = extractUnityProjectSettings(rootDir);
    if (unityExtraction) {
      appConfig = {
        ...appConfig,
        app_name: appConfig.app_name ?? unityExtraction.product_name,
        bundle_id: appConfig.bundle_id ?? unityExtraction.bundle_id,
        version: appConfig.version ?? unityExtraction.app_version,
      };
      extraEvidence = unityExtraction.evidence;
    }
  }

  // Signals: caller-provided files win; otherwise self-scan. A self-scan that
  // finds no source at all -> null signals (honest "we didn't see any source").
  let signals: SourceSignals | null;
  if (input.sourceFiles !== undefined) {
    signals = scanSourceSignals({ files: input.sourceFiles });
  } else {
    const selfFiles = selfScanSource(rootDir, stack);
    signals = selfFiles.length > 0 ? scanSourceSignals({ files: selfFiles }) : null;
  }

  const profile = buildAppProfile({
    rootDir,
    stackResult,
    appConfig,
    deps,
    sdks,
    registry: bundle.sdk_registry,
    ios,
    entitlements,
    privacyManifest,
    android,
    gradleTargets,
    signals,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });

  if (extraEvidence) {
    profile.evidence = { ...profile.evidence, ...extraEvidence };
  }

  const { checks, findings } = evaluateRules(profile, bundle);

  return { profile, checks, findings };
}

export type { RuleEvaluationResult } from "./rules.js";
export { evaluateRules, resolveFact, evaluateCondition } from "./rules.js";
export { buildAppProfile, scanSourceSignals } from "./profile-builder.js";
