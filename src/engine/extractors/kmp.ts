import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findFile, readFileSafe } from "../../utils/file-scanner.js";

export interface KmpLayout {
  iosAppDir: string | null;
  androidModuleDir: string | null;
  sharedDir: string | null;
}

/** True when a directory ending in ".xcodeproj" exists anywhere under `dir` within `maxDepth` levels. */
function containsXcodeproj(dir: string, maxDepth: number): boolean {
  function walk(current: string, depth: number): boolean {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      if (entry.endsWith(".xcodeproj")) return true;
      if (depth < maxDepth && walk(full, depth + 1)) return true;
    }
    return false;
  }
  return walk(dir, 0);
}

// A module's build.gradle(.kts) is "the" Android application module when it
// either declares an applicationId or applies the android application
// plugin (covers both Groovy `id 'com.android.application'` and KTS
// `id("com.android.application")` forms via the plain substring).
const ANDROID_APPLICATION_MODULE_RE = /applicationId\b|com\.android\.application/;

// Same marker set as tech-detector.ts's KMP_PLUGIN_MARKER_RE (kept as an
// independent literal here rather than a shared import - these two files
// belong to different layers, analyzers vs engine, and the pattern is a
// three-token regex unlikely to drift silently out of sync).
const KMP_PLUGIN_MARKER_RE =
  /kotlin\(\s*["']multiplatform["']\s*\)|id\(\s*["']org\.jetbrains\.kotlin\.multiplatform["']\s*\)|kotlinMultiplatform/;

function readModuleGradle(moduleDir: string): string | null {
  return readFileSafe(join(moduleDir, "build.gradle.kts")) ?? readFileSafe(join(moduleDir, "build.gradle"));
}

/**
 * Locates the conventional Kotlin Multiplatform module layout:
 *   - iosAppDir: `iosApp/`, when it contains an `.xcodeproj` or an
 *     `Info.plist` within depth 3.
 *   - androidModuleDir: the first of `androidApp/`, `composeApp/`, `app/`
 *     whose build.gradle(.kts) looks like the Android application module.
 *   - sharedDir: the first direct child directory of `rootDir` whose build
 *     gradle declares the Kotlin Multiplatform plugin.
 *
 * Every field is independently best-effort (null when not found) - callers
 * gate on each field individually rather than requiring all three.
 */
export function findKmpLayout(rootDir: string): KmpLayout {
  let iosAppDir: string | null = null;
  const iosAppCandidate = join(rootDir, "iosApp");
  if (existsSync(iosAppCandidate)) {
    const hasXcodeproj = containsXcodeproj(iosAppCandidate, 3);
    const hasInfoPlist = findFile(iosAppCandidate, "Info.plist", 3) !== null;
    if (hasXcodeproj || hasInfoPlist) iosAppDir = iosAppCandidate;
  }

  let androidModuleDir: string | null = null;
  for (const name of ["androidApp", "composeApp", "app"]) {
    const candidate = join(rootDir, name);
    const content = readModuleGradle(candidate);
    if (content && ANDROID_APPLICATION_MODULE_RE.test(content)) {
      androidModuleDir = candidate;
      break;
    }
  }

  let sharedDir: string | null = null;
  try {
    const entries = [...readdirSync(rootDir)].sort();
    for (const entry of entries) {
      const candidate = join(rootDir, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(candidate).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      const content = readModuleGradle(candidate);
      if (content && KMP_PLUGIN_MARKER_RE.test(content)) {
        sharedDir = candidate;
        break;
      }
    }
  } catch {
    /* rootDir unreadable - leave sharedDir null */
  }

  return { iosAppDir, androidModuleDir, sharedDir };
}
