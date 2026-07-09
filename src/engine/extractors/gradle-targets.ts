import { join, relative } from "node:path";
import { findFile, findFiles, readFileSafe } from "../../utils/file-scanner.js";
import type { EvidenceMap } from "./shared.js";

export interface GradleTargetsExtraction {
  target_android_sdk: number | null;
  compile_sdk: number | null;   // returned for evidence only; AppProfile carries target + min only
  min_android_sdk: number | null;
  evidence: EvidenceMap;
}

/**
 * Candidate app-module gradle files, in priority order. Mirrors the two
 * layouts config-parser.ts handles for different stacks (pure Android:
 * "app/build.gradle"; Flutter: "android/app/build.gradle") plus a
 * depth-4 fallback scan for anything else (multi-module projects that
 * place the Android application module elsewhere).
 */
function candidateGradleFiles(rootDir: string): string[] {
  const candidates: string[] = [];
  const add = (p: string | null) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  add(findFile(join(rootDir, "app"), "build.gradle", 2));
  add(findFile(join(rootDir, "app"), "build.gradle.kts", 2));
  add(findFile(join(rootDir, "android/app"), "build.gradle", 2));
  add(findFile(join(rootDir, "android/app"), "build.gradle.kts", 2));
  add(findFile(rootDir, "build.gradle", 1));
  add(findFile(rootDir, "build.gradle.kts", 1));
  for (const f of findFiles(rootDir, ["build.gradle", "build.gradle.kts"], 4)) {
    add(f);
  }
  return candidates;
}

/**
 * Matches both Groovy (`targetSdkVersion 34`, `targetSdk 34`) and KTS
 * (`targetSdk = 34`) syntax for a given setting name. An indirection like
 * `flutter.targetSdkVersion` has no digits where this pattern expects them,
 * so it simply fails to match at that occurrence (correctly yielding null
 * unless a literal numeric override appears elsewhere in the file).
 */
function extractIntSetting(content: string, name: string): number | null {
  const pattern = new RegExp(`\\b${name}(?:Version)?\\s*(?:=)?\\s*(\\d+)`);
  const match = content.match(pattern);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extracts target/compile/min Android SDK levels from the app module's
 * build.gradle(.kts). Regex-based, consistent with this repo's established
 * config-parsing approach (no Gradle/Kotlin-DSL dependency).
 */
export function extractGradleTargets(rootDir: string): GradleTargetsExtraction {
  const evidence: EvidenceMap = {};

  let targetAndroidSdk: number | null = null;
  let compileSdk: number | null = null;
  let minAndroidSdk: number | null = null;
  let usedFile: string | null = null;

  for (const filePath of candidateGradleFiles(rootDir)) {
    const content = readFileSafe(filePath);
    if (!content) continue;

    const target = extractIntSetting(content, "targetSdk");
    const compile = extractIntSetting(content, "compileSdk");
    const min = extractIntSetting(content, "minSdk");

    if (target === null && compile === null && min === null) continue;

    if (targetAndroidSdk === null && target !== null) targetAndroidSdk = target;
    if (compileSdk === null && compile !== null) compileSdk = compile;
    if (minAndroidSdk === null && min !== null) minAndroidSdk = min;
    if (usedFile === null) usedFile = filePath;

    if (targetAndroidSdk !== null && compileSdk !== null && minAndroidSdk !== null) break;
  }

  if (usedFile) {
    evidence["android.gradle"] = { file: relative(rootDir, usedFile) };
  }

  return {
    target_android_sdk: targetAndroidSdk,
    compile_sdk: compileSdk,
    min_android_sdk: minAndroidSdk,
    evidence,
  };
}
