import { readdirSync } from "fs";
import { join } from "path";
import plist from "plist";
import YAML from "yaml";
import type { TechStack, ParsedConfig } from "../types/report.js";
import { readFileSafe, findFile, findAllFiles } from "../utils/file-scanner.js";

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
    case "react-native":
      return parseReactNativeConfig(rootDir);
    case "swift":
      return parseSwiftConfig(rootDir);
    case "kotlin":
    case "java":
      return parseAndroidConfig(rootDir);
    case "capacitor":
      return parseCapacitorConfig(rootDir);
    case "dotnet-maui":
      return parseMauiConfig(rootDir);
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

  // build.gradle
  const buildGradlePath =
    findFile(join(rootDir, "app"), "build.gradle", 2) ||
    findFile(join(rootDir, "app"), "build.gradle.kts", 2) ||
    findFile(rootDir, "build.gradle", 1) ||
    findFile(rootDir, "build.gradle.kts", 1);

  if (buildGradlePath) {
    const gradleConfig = parseGradle(buildGradlePath);
    config.bundle_id = gradleConfig.applicationId || null;
    config.version = gradleConfig.versionName || null;
    config.min_android_sdk = gradleConfig.minSdk || null;
  }

  // AndroidManifest.xml for app name
  const manifestPath = findFile(rootDir, "AndroidManifest.xml", 6);
  if (manifestPath) {
    const content = readFileSafe(manifestPath);
    if (content) {
      const labelMatch = content.match(/android:label="([^"]+)"/);
      if (labelMatch && !labelMatch[1].startsWith("@")) {
        config.app_name = labelMatch[1];
      }
    }
  }

  // strings.xml for app name
  if (!config.app_name) {
    const stringsPath = findFile(rootDir, "strings.xml", 8);
    if (stringsPath) {
      const content = readFileSafe(stringsPath);
      if (content) {
        const nameMatch = content.match(
          /<string name="app_name">(.*?)<\/string>/
        );
        if (nameMatch) config.app_name = nameMatch[1];
      }
    }
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
