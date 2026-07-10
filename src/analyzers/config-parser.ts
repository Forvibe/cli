import { readdirSync } from "fs";
import { join } from "path";
import plist from "plist";
import YAML from "yaml";
import type { TechStack, ParsedConfig } from "../types/report.js";
import { readFileSafe, findFile, findFiles, findAllFiles } from "../utils/file-scanner.js";

/**
 * Parse project configuration based on detected tech stack
 */
export function parseConfig(
  rootDir: string,
  techStack: TechStack
): ParsedConfig {
  switch (techStack) {
    case "flutter":
      return parseFlutterConfig(rootDir);
    case "expo":
      return parseExpoConfig(rootDir);
    case "react-native":
      return parseReactNativeConfig(rootDir);
    case "swift":
      return parseSwiftConfig(rootDir);
    case "kotlin":
      return parseAndroidConfig(rootDir);
    case "capacitor":
      return parseCapacitorConfig(rootDir);
    case "dotnet-maui":
      return parseMauiConfig(rootDir);
    case "unity":
      return parseUnityConfig(rootDir);
    case "kmp":
      return parseKmpConfig(rootDir);
    default:
      return emptyConfig();
  }
}

function emptyConfig(): ParsedConfig {
  return {
    app_name: null,
    bundle_id: null,
    version: null,
    min_ios_version: null,
    min_android_sdk: null,
    description: null,
  };
}

// =============================================
// Flutter
// =============================================

function parseFlutterConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  // pubspec.yaml
  const pubspecContent = readFileSafe(join(rootDir, "pubspec.yaml"));
  if (pubspecContent) {
    try {
      const pubspec = YAML.parse(pubspecContent);
      config.app_name = pubspec.name || null;
      config.description = pubspec.description || null;
      config.version = pubspec.version?.split("+")[0] || null;
    } catch { /* ignore parse errors */ }
  }

  // iOS Info.plist for Bundle ID
  const infoPlistPath = findFile(
    join(rootDir, "ios"),
    "Info.plist",
    4
  );
  if (infoPlistPath) {
    const plistData = parsePlist(infoPlistPath);
    if (plistData) {
      config.bundle_id =
        (plistData.CFBundleIdentifier as string) || config.bundle_id;
      config.min_ios_version =
        (plistData.MinimumOSVersion as string) || null;
    }
  }

  // iOS project.pbxproj for bundle ID if not found in Info.plist
  if (!config.bundle_id || config.bundle_id.includes("$(")) {
    const pbxprojPath = findFile(join(rootDir, "ios"), "project.pbxproj", 4);
    if (pbxprojPath) {
      const content = readFileSafe(pbxprojPath);
      if (content) {
        const bundleMatch = content.match(
          /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";]+)"?/
        );
        if (bundleMatch && !bundleMatch[1].includes("$(")) {
          config.bundle_id = bundleMatch[1];
        }
      }
    }
  }

  // Android build.gradle for Android details
  const buildGradlePath =
    findFile(join(rootDir, "android/app"), "build.gradle", 2) ||
    findFile(join(rootDir, "android/app"), "build.gradle.kts", 2);
  if (buildGradlePath) {
    const gradleConfig = parseGradle(buildGradlePath);
    if (!config.bundle_id && gradleConfig.applicationId) {
      config.bundle_id = gradleConfig.applicationId;
    }
    config.min_android_sdk = gradleConfig.minSdk || null;
  }

  return config;
}

// =============================================
// Expo
// =============================================

function parseExpoConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  // 1. app.json (static config) — preferred when expo block exists
  const appJsonContent = readFileSafe(join(rootDir, "app.json"));
  if (appJsonContent) {
    try {
      const appJson = JSON.parse(appJsonContent);
      const expo = appJson.expo || appJson;
      config.app_name = expo.name || appJson.displayName || appJson.name || null;
      config.version = expo.version || null;
      config.bundle_id =
        expo.ios?.bundleIdentifier ||
        expo.android?.package ||
        null;
      config.description = expo.description || null;
      config.min_ios_version = expo.ios?.deploymentTarget || null;
    } catch { /* ignore */ }
  }

  // 2. app.config.js / app.config.ts — regex fallback (no eval)
  if (!config.app_name || !config.bundle_id || !config.version) {
    for (const name of ["app.config.ts", "app.config.js"]) {
      const content = readFileSafe(join(rootDir, name));
      if (!content) continue;
      if (!config.app_name) {
        const m = content.match(/name\s*:\s*['"]([^'"]+)['"]/);
        if (m) config.app_name = m[1];
      }
      if (!config.version) {
        const m = content.match(/version\s*:\s*['"]([^'"]+)['"]/);
        if (m) config.version = m[1];
      }
      if (!config.bundle_id) {
        const m =
          content.match(/bundleIdentifier\s*:\s*['"]([^'"]+)['"]/) ||
          content.match(/package\s*:\s*['"]([^'"]+)['"]/);
        if (m) config.bundle_id = m[1];
      }
      if (!config.description) {
        const m = content.match(/description\s*:\s*['"]([^'"]+)['"]/);
        if (m) config.description = m[1];
      }
    }
  }

  // 3. package.json fallbacks
  const pkgContent = readFileSafe(join(rootDir, "package.json"));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      if (!config.version) config.version = pkg.version || null;
      if (!config.description) config.description = pkg.description || null;
      if (!config.app_name) config.app_name = pkg.name || null;
    } catch { /* ignore */ }
  }

  // 4. If user ejected to bare workflow, fall back to native sources
  if (!config.bundle_id || !config.app_name) {
    const infoPlistPath = findFile(join(rootDir, "ios"), "Info.plist", 4);
    if (infoPlistPath) {
      const plistData = parsePlist(infoPlistPath);
      if (plistData) {
        if (!config.bundle_id) {
          const id = plistData.CFBundleIdentifier as string | undefined;
          if (id && !isXcodeVariable(id)) config.bundle_id = id;
        }
        if (!config.app_name) {
          const display =
            (plistData.CFBundleDisplayName as string | undefined) ||
            (plistData.CFBundleName as string | undefined);
          if (display && !isXcodeVariable(display)) config.app_name = display;
        }
      }
    }
  }
  if (!config.bundle_id) {
    const buildGradlePath =
      findFile(join(rootDir, "android/app"), "build.gradle", 2) ||
      findFile(join(rootDir, "android/app"), "build.gradle.kts", 2);
    if (buildGradlePath) {
      const gradleConfig = parseGradle(buildGradlePath);
      if (gradleConfig.applicationId) config.bundle_id = gradleConfig.applicationId;
      if (!config.min_android_sdk) config.min_android_sdk = gradleConfig.minSdk || null;
    }
  }
  if (!config.app_name) {
    config.app_name = readAndroidAppName(join(rootDir, "android"));
  }

  return config;
}

// =============================================
// React Native
// =============================================

function parseReactNativeConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  // app.json
  const appJsonContent = readFileSafe(join(rootDir, "app.json"));
  if (appJsonContent) {
    try {
      const appJson = JSON.parse(appJsonContent);
      config.app_name = appJson.displayName || appJson.name || null;
    } catch { /* ignore */ }
  }

  // app.config.ts/js — regex fallback (matches string-literal name only).
  // Covers projects that were detected as bare RN but actually ship an
  // Expo-style dynamic config, or RN projects using a shared config helper.
  if (!config.app_name) {
    for (const name of ["app.config.ts", "app.config.js"]) {
      const content = readFileSafe(join(rootDir, name));
      if (!content) continue;
      const m = content.match(/name\s*:\s*['"]([^'"]+)['"]/);
      if (m) { config.app_name = m[1]; break; }
    }
  }

  // package.json
  const pkgContent = readFileSafe(join(rootDir, "package.json"));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      config.version = pkg.version || null;
      config.description = pkg.description || null;
      if (!config.app_name) config.app_name = pkg.name || null;
    } catch { /* ignore */ }
  }

  // iOS Info.plist
  const infoPlistPath = findFile(join(rootDir, "ios"), "Info.plist", 4);
  if (infoPlistPath) {
    const plistData = parsePlist(infoPlistPath);
    if (plistData) {
      config.bundle_id =
        (plistData.CFBundleIdentifier as string) || null;
      config.min_ios_version =
        (plistData.MinimumOSVersion as string) || null;
      if (!config.app_name) {
        const display =
          (plistData.CFBundleDisplayName as string) ||
          (plistData.CFBundleName as string);
        if (display && !isXcodeVariable(display)) {
          config.app_name = display;
        }
      }
    }
  }

  // iOS project.pbxproj for bundle ID
  if (!config.bundle_id || config.bundle_id.includes("$(")) {
    const pbxprojPath = findFile(join(rootDir, "ios"), "project.pbxproj", 4);
    if (pbxprojPath) {
      const content = readFileSafe(pbxprojPath);
      if (content) {
        const bundleMatch = content.match(
          /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";]+)"?/
        );
        if (bundleMatch && !bundleMatch[1].includes("$(")) {
          config.bundle_id = bundleMatch[1];
        }
      }
    }
  }

  // Android build.gradle
  const buildGradlePath =
    findFile(join(rootDir, "android/app"), "build.gradle", 2) ||
    findFile(join(rootDir, "android/app"), "build.gradle.kts", 2);
  if (buildGradlePath) {
    const gradleConfig = parseGradle(buildGradlePath);
    if (!config.bundle_id && gradleConfig.applicationId) {
      config.bundle_id = gradleConfig.applicationId;
    }
    config.min_android_sdk = gradleConfig.minSdk || null;
  }

  // Android native fallback for app_name (AndroidManifest label / strings.xml)
  if (!config.app_name) {
    config.app_name = readAndroidAppName(join(rootDir, "android"));
  }

  return config;
}

// =============================================
// Swift / iOS Native
// =============================================

// Known Xcode extension suffixes — these are NOT the main app target
const EXTENSION_SUFFIXES = [
  "Extension", "Widget", "WidgetExtension", "Intent", "IntentExtension",
  "NotificationService", "NotificationContent", "ShieldConfiguration",
  "ShieldConfigurationExtension", "ShieldAction", "ShieldActionExtension",
  "WatchKit", "Watch", "Clip", "Tests", "UITests", "StickerPack",
  "ShareExtension", "TodayExtension", "KeyboardExtension",
];

function isExtensionBundleId(bundleId: string): boolean {
  return EXTENSION_SUFFIXES.some(
    (suffix) =>
      bundleId.endsWith(`.${suffix}`) ||
      bundleId.toLowerCase().endsWith(`.${suffix.toLowerCase()}`)
  );
}

function isXcodeVariable(value: string): boolean {
  return value.includes("$(") || value.includes("${");
}

/**
 * Parse project.pbxproj to find the main app target's bundle ID and metadata.
 * Scans all PRODUCT_BUNDLE_IDENTIFIER entries, filters out extensions,
 * and picks the shortest (most likely the main app).
 */
function parsePbxproj(content: string): {
  bundleId: string | null;
  appName: string | null;
  version: string | null;
  minIos: string | null;
} {
  // Collect ALL bundle IDs from the project
  const bundleIdMatches = content.matchAll(
    /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";]+)"?/g
  );
  const allBundleIds: string[] = [];
  for (const match of bundleIdMatches) {
    const id = match[1].trim();
    if (!isXcodeVariable(id)) {
      allBundleIds.push(id);
    }
  }

  // Filter out extension bundle IDs and pick the shortest (most likely the main app)
  let bundleId: string | null = null;
  const nonExtensionIds = allBundleIds.filter((id) => !isExtensionBundleId(id));
  if (nonExtensionIds.length > 0) {
    // Shortest non-extension bundle ID is most likely the main app
    bundleId = nonExtensionIds.sort((a, b) => a.length - b.length)[0];
  } else if (allBundleIds.length > 0) {
    // All are extensions — pick shortest as fallback
    bundleId = allBundleIds.sort((a, b) => a.length - b.length)[0];
  }

  // Find app name: look for PRODUCT_NAME that isn't a variable
  let appName: string | null = null;
  const productNames = content.matchAll(
    /PRODUCT_NAME\s*=\s*"?([^";]+)"?/g
  );
  for (const match of productNames) {
    const name = match[1].trim();
    if (!isXcodeVariable(name) && name !== "$(TARGET_NAME)") {
      appName = name;
      break;
    }
  }

  // If no PRODUCT_NAME found, derive from the main bundle ID
  if (!appName && bundleId) {
    const parts = bundleId.split(".");
    appName = parts[parts.length - 1]
      .replace(/[-_]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2"); // camelCase → "camel Case"
  }

  // Also try INFOPLIST_KEY_CFBundleDisplayName (modern SwiftUI projects)
  if (!appName || isXcodeVariable(appName)) {
    const displayNameMatch = content.match(
      /INFOPLIST_KEY_CFBundleDisplayName\s*=\s*"?([^";]+)"?/
    );
    if (displayNameMatch && !isXcodeVariable(displayNameMatch[1])) {
      appName = displayNameMatch[1].trim();
    }
  }

  const versionMatch = content.match(
    /MARKETING_VERSION\s*=\s*"?([^";]+)"?/
  );
  const iosMatch = content.match(
    /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*"?([^";]+)"?/
  );

  return {
    bundleId,
    appName,
    version: versionMatch ? versionMatch[1].trim() : null,
    minIos: iosMatch ? iosMatch[1].trim() : null,
  };
}

function parseSwiftConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  // 1. Parse project.pbxproj FIRST — it's the most reliable source for Swift projects
  const pbxprojPath = findFile(rootDir, "project.pbxproj", 5);
  if (pbxprojPath) {
    const content = readFileSafe(pbxprojPath);
    if (content) {
      const pbx = parsePbxproj(content);
      config.bundle_id = pbx.bundleId;
      config.app_name = pbx.appName;
      config.version = pbx.version;
      config.min_ios_version = pbx.minIos;
    }
  }

  // 2. Try Info.plist to fill in missing data — but only from the main target directory
  //    Prefer Info.plist next to the main source files, skip extension plists
  const allPlists = findAllFiles(rootDir, "Info.plist", 5);
  const mainPlist = allPlists.find(
    (p) => !EXTENSION_SUFFIXES.some((ext) => p.includes(ext))
  );

  if (mainPlist) {
    const plistData = parsePlist(mainPlist);
    if (plistData) {
      if (!config.app_name || isXcodeVariable(config.app_name)) {
        const plistName =
          (plistData.CFBundleDisplayName as string) ||
          (plistData.CFBundleName as string);
        if (plistName && !isXcodeVariable(plistName)) {
          config.app_name = plistName;
        }
      }
      if (!config.bundle_id || isXcodeVariable(config.bundle_id)) {
        const plistBundleId = plistData.CFBundleIdentifier as string;
        if (plistBundleId && !isXcodeVariable(plistBundleId)) {
          config.bundle_id = plistBundleId;
        }
      }
      if (!config.version) {
        config.version =
          (plistData.CFBundleShortVersionString as string) || null;
      }
      if (!config.min_ios_version) {
        config.min_ios_version =
          (plistData.MinimumOSVersion as string) || null;
      }
    }
  }

  // 3. Fallback: derive app name from .xcodeproj folder name
  if (!config.app_name || isXcodeVariable(config.app_name)) {
    try {
      const entries = readdirSync(rootDir);
      for (const entry of entries) {
        if (entry.endsWith(".xcodeproj")) {
          config.app_name = entry.replace(".xcodeproj", "");
          break;
        }
      }
    } catch { /* ignore */ }
  }

  return config;
}

// =============================================
// Android (Kotlin/Java)
// =============================================

function parseAndroidConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  // build.gradle — try well-known module locations first, then fall back
  // to any build.gradle[.kts] in the tree (multi-module projects with
  // feature/ or core/ modules often place applicationId outside app/).
  const candidates: string[] = [];
  const addCandidate = (p: string | null) => { if (p) candidates.push(p); };
  addCandidate(findFile(join(rootDir, "app"), "build.gradle", 2));
  addCandidate(findFile(join(rootDir, "app"), "build.gradle.kts", 2));
  addCandidate(findFile(rootDir, "build.gradle", 1));
  addCandidate(findFile(rootDir, "build.gradle.kts", 1));
  for (const f of findFiles(rootDir, ["build.gradle", "build.gradle.kts"], 4)) {
    if (!candidates.includes(f)) candidates.push(f);
  }

  for (const path of candidates) {
    const g = parseGradle(path);
    if (!config.bundle_id && g.applicationId) config.bundle_id = g.applicationId;
    if (!config.version && g.versionName) config.version = g.versionName;
    if (!config.min_android_sdk && g.minSdk) config.min_android_sdk = g.minSdk;
    if (config.bundle_id && config.version && config.min_android_sdk) break;
  }

  // App name from AndroidManifest.xml (@string resolution) + strings.xml fallback
  if (!config.app_name) {
    config.app_name = readAndroidAppName(rootDir);
  }

  return config;
}

// =============================================
// Capacitor
// =============================================

function parseCapacitorConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  // capacitor.config.ts/js/json
  for (const name of [
    "capacitor.config.json",
    "capacitor.config.ts",
    "capacitor.config.js",
  ]) {
    const content = readFileSafe(join(rootDir, name));
    if (content) {
      // Try JSON
      if (name.endsWith(".json")) {
        try {
          const capConfig = JSON.parse(content);
          config.app_name = capConfig.appName || null;
          config.bundle_id = capConfig.appId || null;
        } catch { /* ignore */ }
      } else {
        // Parse TS/JS config
        const appIdMatch = content.match(/appId:\s*['"]([^'"]+)['"]/);
        const appNameMatch = content.match(/appName:\s*['"]([^'"]+)['"]/);
        if (appIdMatch) config.bundle_id = appIdMatch[1];
        if (appNameMatch) config.app_name = appNameMatch[1];
      }
      break;
    }
  }

  // package.json for version
  const pkgContent = readFileSafe(join(rootDir, "package.json"));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      config.version = pkg.version || null;
      config.description = pkg.description || null;
    } catch { /* ignore */ }
  }

  return config;
}

// =============================================
// .NET MAUI
// =============================================

function parseMauiConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  // .csproj file
  try {
    const entries = readdirSync(rootDir);
    for (const entry of entries) {
      if (entry.endsWith(".csproj")) {
        const content = readFileSafe(join(rootDir, entry));
        if (content) {
          const appIdMatch = content.match(
            /<ApplicationId>(.*?)<\/ApplicationId>/
          );
          const titleMatch = content.match(
            /<ApplicationTitle>(.*?)<\/ApplicationTitle>/
          );
          const versionMatch = content.match(
            /<ApplicationDisplayVersion>(.*?)<\/ApplicationDisplayVersion>/
          );

          if (appIdMatch) config.bundle_id = appIdMatch[1];
          if (titleMatch) config.app_name = titleMatch[1];
          if (versionMatch) config.version = versionMatch[1];
        }
        break;
      }
    }
  } catch { /* ignore */ }

  return config;
}

// =============================================
// Unity
// =============================================

/**
 * Parses ProjectSettings/ProjectSettings.asset with small dedicated regexes
 * (deliberately NOT the engine's extractUnityProjectSettings/yaml.parse
 * path - see rsv2-task-4-brief.md: this keeps analyzers/ from taking a
 * dependency on engine/, even though no cycle would actually result today).
 */
function parseUnityConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  const content = readFileSafe(
    join(rootDir, "ProjectSettings", "ProjectSettings.asset")
  );
  if (!content) return config;

  const productNameMatch = content.match(/^\s*productName:\s*(.+)$/m);
  if (productNameMatch) config.app_name = productNameMatch[1].trim();

  const versionMatch = content.match(/^\s*bundleVersion:\s*(\S+)/m);
  if (versionMatch) config.version = versionMatch[1].trim();

  // applicationIdentifier block: prefer iPhone, fall back to Android. Bounded
  // to the block itself (stops at the next line back at <=2-space indent,
  // i.e. the next sibling PlayerSettings key) so an unrelated key elsewhere
  // in the file can never be picked up by mistake.
  const blockIdx = content.indexOf("applicationIdentifier:");
  if (blockIdx >= 0) {
    const after = content.slice(blockIdx + "applicationIdentifier:".length);
    const nextSiblingKey = after.search(/\n {0,2}\S/);
    const block = nextSiblingKey >= 0 ? after.slice(0, nextSiblingKey) : after;
    const iphone = block.match(/iPhone:\s*(\S+)/);
    const android = block.match(/Android:\s*(\S+)/);
    const id = iphone?.[1] ?? android?.[1] ?? null;
    if (id) config.bundle_id = id.trim();
  }

  return config;
}

// =============================================
// Kotlin Multiplatform
// =============================================

/**
 * `bundle_id` from the Android application module's build.gradle(.kts)
 * (androidApp/, composeApp/, app/ in that order); `app_name` /
 * `min_ios_version` from iosApp's Info.plist.
 */
function parseKmpConfig(rootDir: string): ParsedConfig {
  const config = emptyConfig();

  for (const moduleName of ["androidApp", "composeApp", "app"]) {
    const moduleDir = join(rootDir, moduleName);
    let gradleConfig = parseGradle(join(moduleDir, "build.gradle.kts"));
    if (!gradleConfig.applicationId) {
      gradleConfig = parseGradle(join(moduleDir, "build.gradle"));
    }
    if (gradleConfig.applicationId) {
      config.bundle_id = gradleConfig.applicationId;
      if (gradleConfig.versionName) config.version = gradleConfig.versionName;
      if (gradleConfig.minSdk) config.min_android_sdk = gradleConfig.minSdk;
      break;
    }
  }

  const infoPlistPath = findFile(join(rootDir, "iosApp"), "Info.plist", 3);
  if (infoPlistPath) {
    const plistData = parsePlist(infoPlistPath);
    if (plistData) {
      const displayName =
        (plistData.CFBundleDisplayName as string) ||
        (plistData.CFBundleName as string);
      if (displayName && !isXcodeVariable(displayName)) {
        config.app_name = displayName;
      }
      if (!config.min_ios_version) {
        config.min_ios_version = (plistData.MinimumOSVersion as string) || null;
      }
    }
  }

  return config;
}

// =============================================
// Helpers
// =============================================

function parsePlist(
  filePath: string
): Record<string, unknown> | null {
  const content = readFileSafe(filePath);
  if (!content) return null;
  try {
    return plist.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface GradleConfig {
  applicationId: string | null;
  versionName: string | null;
  minSdk: string | null;
}

/**
 * Look up a <string name="…"> value in any strings.xml under `searchDir`.
 * Used to resolve `@string/foo` references from AndroidManifest.
 */
function lookupAndroidString(
  searchDir: string,
  stringName: string
): string | null {
  const stringsPath = findFile(searchDir, "strings.xml", 8);
  if (!stringsPath) return null;
  const content = readFileSafe(stringsPath);
  if (!content) return null;
  const escaped = stringName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const pattern = new RegExp(
    `<string\\s+name="${escaped}"[^>]*>([\\s\\S]*?)<\\/string>`
  );
  const m = content.match(pattern);
  return m ? m[1].trim() : null;
}

/**
 * Best-effort app display name lookup from Android native sources.
 * Reads AndroidManifest.xml `android:label`, resolving `@string/…` refs
 * against strings.xml. Used both for pure Kotlin projects (searchDir = rootDir)
 * and for RN/Expo ejected projects (searchDir = rootDir/android).
 */
function readAndroidAppName(searchDir: string): string | null {
  const manifestPath = findFile(searchDir, "AndroidManifest.xml", 6);
  if (manifestPath) {
    const content = readFileSafe(manifestPath);
    if (content) {
      const labelMatch = content.match(/android:label\s*=\s*"([^"]+)"/);
      if (labelMatch) {
        const label = labelMatch[1];
        const stringRef = label.match(/^@string\/(.+)$/);
        if (stringRef) {
          const resolved = lookupAndroidString(searchDir, stringRef[1]);
          if (resolved) return resolved;
        } else if (!label.startsWith("@")) {
          return label;
        }
      }
    }
  }

  // Fallback: conventional "app_name" string when manifest has no label
  return lookupAndroidString(searchDir, "app_name");
}

function parseGradle(filePath: string): GradleConfig {
  const content = readFileSafe(filePath);
  if (!content) return { applicationId: null, versionName: null, minSdk: null };

  const appIdMatch = content.match(
    /applicationId\s*[=:]\s*['"]([^'"]+)['"]/
  );
  const versionMatch = content.match(
    /versionName\s*[=:]\s*['"]([^'"]+)['"]/
  );
  const minSdkMatch = content.match(
    /minSdk(?:Version)?\s*[=:]\s*(\d+)/
  );

  return {
    applicationId: appIdMatch?.[1] || null,
    versionName: versionMatch?.[1] || null,
    minSdk: minSdkMatch?.[1] || null,
  };
}
