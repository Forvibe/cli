import { existsSync, readdirSync } from "fs";
import { join, relative } from "path";
import type { TechStack, TechStackResult } from "../types/report.js";
import { readFileSafe, findFiles } from "../utils/file-scanner.js";

interface DetectionRule {
  stack: TechStack;
  label: string;
  platforms: ("ios" | "android")[];
  detect: (rootDir: string) => string[];
}

// Matches any of the three ways a Gradle module declares the Kotlin
// Multiplatform plugin (KTS function-call form, KTS/Groovy plugin-id form,
// or the version-catalog alias name used in generated KMP wizard projects).
const KMP_PLUGIN_MARKER_RE =
  /kotlin\(\s*["']multiplatform["']\s*\)|id\(\s*["']org\.jetbrains\.kotlin\.multiplatform["']\s*\)|kotlinMultiplatform/;

/**
 * Finds the first module `build.gradle(.kts)` (depth-2 scan, so it reaches
 * e.g. "shared/build.gradle.kts") whose content declares the Kotlin
 * Multiplatform plugin. Returns the path relative to `dir`, or null.
 * Deliberately does NOT special-case the root gradle file: it is already
 * covered by the separate "root gradle file exists" check in the kmp rule,
 * and a real KMP wizard project's root build.gradle.kts only ever applies
 * the plugin with `apply false` for subprojects to use - it's the module
 * (e.g. shared/) that actually activates it.
 */
function findKmpModuleGradleFile(dir: string): string | null {
  const candidates = findFiles(dir, ["build.gradle.kts", "build.gradle"], 2);
  for (const candidate of candidates) {
    const content = readFileSafe(candidate);
    if (content && KMP_PLUGIN_MARKER_RE.test(content)) {
      return relative(dir, candidate);
    }
  }
  return null;
}

const DETECTION_RULES: DetectionRule[] = [
  {
    stack: "flutter",
    label: "Flutter (Dart)",
    platforms: ["ios", "android"],
    detect: (dir) => {
      const files: string[] = [];
      if (existsSync(join(dir, "pubspec.yaml"))) files.push("pubspec.yaml");
      if (existsSync(join(dir, "lib"))) files.push("lib/");
      if (existsSync(join(dir, "android"))) files.push("android/");
      if (existsSync(join(dir, "ios"))) files.push("ios/");
      return files.length >= 2 ? files : [];
    },
  },
  {
    stack: "expo",
    label: "Expo (React Native)",
    platforms: ["ios", "android"],
    detect: (dir) => {
      const files: string[] = [];
      const pkgPath = join(dir, "package.json");
      const pkgContent = existsSync(pkgPath) ? readFileSafe(pkgPath) : null;
      let hasExpoDep = false;
      if (pkgContent) {
        try {
          const pkg = JSON.parse(pkgContent);
          const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          if ("expo" in allDeps) {
            hasExpoDep = true;
          }
        } catch { /* ignore */ }
      }

      let hasExpoBlock = false;
      const appJsonPath = join(dir, "app.json");
      if (existsSync(appJsonPath)) {
        const appJson = readFileSafe(appJsonPath);
        if (appJson && /"expo"\s*:\s*\{/.test(appJson)) {
          hasExpoBlock = true;
        }
      }

      const hasAppConfig =
        existsSync(join(dir, "app.config.js")) ||
        existsSync(join(dir, "app.config.ts"));
      const hasEas = existsSync(join(dir, "eas.json"));

      if (hasExpoDep || hasExpoBlock || hasEas) {
        if (pkgContent) files.push("package.json");
        if (hasExpoBlock) files.push("app.json");
        if (hasAppConfig) files.push(existsSync(join(dir, "app.config.ts")) ? "app.config.ts" : "app.config.js");
        if (hasEas) files.push("eas.json");
        if (existsSync(join(dir, "app"))) files.push("app/"); // expo-router
      }
      return files;
    },
  },
  {
    stack: "react-native",
    label: "React Native",
    platforms: ["ios", "android"],
    detect: (dir) => {
      const files: string[] = [];
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const content = readFileSafe(pkgPath);
        if (content && content.includes('"react-native"')) {
          files.push("package.json");
          if (existsSync(join(dir, "app.json"))) files.push("app.json");
          if (existsSync(join(dir, "ios"))) files.push("ios/");
          if (existsSync(join(dir, "android"))) files.push("android/");
        }
      }
      return files;
    },
  },
  {
    stack: "capacitor",
    label: "Capacitor (Ionic)",
    platforms: ["ios", "android"],
    detect: (dir) => {
      const files: string[] = [];
      const configNames = [
        "capacitor.config.ts",
        "capacitor.config.js",
        "capacitor.config.json",
      ];
      for (const name of configNames) {
        if (existsSync(join(dir, name))) {
          files.push(name);
          break;
        }
      }
      if (existsSync(join(dir, "ios"))) files.push("ios/");
      if (existsSync(join(dir, "android"))) files.push("android/");
      return files.length >= 2 ? files : [];
    },
  },
  {
    stack: "swift",
    label: "iOS Native (Swift/Objective-C)",
    platforms: ["ios"],
    detect: (dir) => {
      const files: string[] = [];
      // Check for .xcodeproj or .xcworkspace
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry.endsWith(".xcodeproj")) files.push(entry);
          if (entry.endsWith(".xcworkspace")) files.push(entry);
        }
      } catch { /* ignore */ }
      if (existsSync(join(dir, "Package.swift"))) files.push("Package.swift");
      if (existsSync(join(dir, "Podfile"))) files.push("Podfile");
      // Check for Swift OR Objective-C source files at root (.m/.mm added
      // alongside .swift so an ObjC-only project with no .xcodeproj at root
      // still matches this rule instead of falling through to "unknown").
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry.endsWith(".swift") || entry.endsWith(".m") || entry.endsWith(".mm")) {
            files.push(entry);
            break;
          }
        }
      } catch { /* ignore */ }
      return files;
    },
  },
  {
    stack: "unity",
    label: "Unity",
    platforms: ["ios", "android"],
    detect: (dir) => {
      // All three markers required (unlike most rules' `files.length >= N`
      // threshold): each is individually common in unrelated project types
      // (e.g. any Node project can have a "manifest.json"-shaped file), so
      // requiring all three keeps this rule from ever firing on a
      // non-Unity project.
      const manifest = join(dir, "Packages", "manifest.json");
      const projectSettings = join(dir, "ProjectSettings", "ProjectSettings.asset");
      const assets = join(dir, "Assets");
      if (existsSync(manifest) && existsSync(projectSettings) && existsSync(assets)) {
        return [
          "Packages/manifest.json",
          "ProjectSettings/ProjectSettings.asset",
          "Assets/",
        ];
      }
      return [];
    },
  },
  {
    stack: "kmp",
    label: "Kotlin Multiplatform",
    platforms: ["ios", "android"],
    detect: (dir) => {
      const rootGradleFile = ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"]
        .find((name) => existsSync(join(dir, name)));
      if (!rootGradleFile) return [];

      // iosApp/ is required so a pure-JVM/multi-target KMP *library* (no iOS
      // app shell at all) is not misdetected as a mobile app stack here.
      if (!existsSync(join(dir, "iosApp"))) return [];

      const moduleGradleFile = findKmpModuleGradleFile(dir);
      if (!moduleGradleFile) return [];

      return [rootGradleFile, moduleGradleFile, "iosApp/"];
    },
  },
  {
    stack: "kotlin",
    label: "Android (Kotlin)",
    platforms: ["android"],
    detect: (dir) => {
      const files: string[] = [];
      // Standalone Android project (not cross-platform)
      const hasGradle =
        existsSync(join(dir, "build.gradle")) ||
        existsSync(join(dir, "build.gradle.kts"));
      const hasApp =
        existsSync(join(dir, "app/build.gradle")) ||
        existsSync(join(dir, "app/build.gradle.kts"));
      const hasAndroidManifest = existsSync(
        join(dir, "app/src/main/AndroidManifest.xml")
      );

      if (hasGradle) files.push("build.gradle");
      if (hasApp) files.push("app/build.gradle");
      if (hasAndroidManifest) files.push("AndroidManifest.xml");

      // Make sure this isn't a Flutter or RN project
      if (
        existsSync(join(dir, "pubspec.yaml")) ||
        existsSync(join(dir, "package.json"))
      ) {
        return [];
      }

      return files.length >= 2 ? files : [];
    },
  },
  {
    stack: "dotnet-maui",
    label: ".NET MAUI",
    platforms: ["ios", "android"],
    detect: (dir) => {
      const files: string[] = [];
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry.endsWith(".csproj")) {
            const content = readFileSafe(join(dir, entry));
            if (!content) continue;
            const isMaui =
              /<UseMaui>\s*true\s*<\/UseMaui>/i.test(content) ||
              /Microsoft\.Maui\.Controls/.test(content) ||
              /Microsoft\.Maui\.Sdk/.test(content) ||
              /-android|-ios|-maccatalyst/.test(content);
            if (isMaui) {
              files.push(entry);
            }
          }
        }
      } catch { /* ignore */ }
      if (existsSync(join(dir, "Platforms"))) files.push("Platforms/");
      if (existsSync(join(dir, "Resources"))) files.push("Resources/");
      return files.length >= 1 ? files : [];
    },
  },
];

/**
 * Detect the tech stack of the project in the given directory
 */
export function detectTechStack(rootDir: string): TechStackResult {
  for (const rule of DETECTION_RULES) {
    const configFiles = rule.detect(rootDir);
    if (configFiles.length > 0) {
      return {
        stack: rule.stack,
        label: rule.label,
        platforms: rule.platforms,
        configFiles,
      };
    }
  }

  return {
    stack: "unknown",
    label: "Unknown",
    platforms: [],
    configFiles: [],
  };
}
