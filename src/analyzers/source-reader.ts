import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import type { TechStack } from "../types/report.js";
import { readFileSafe, scanDirectory } from "../utils/file-scanner.js";

const README_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.txt",
  "README",
  "README.rst",
];

// Directories to skip in tree generation
const TREE_IGNORE = new Set([
  "node_modules", ".git", ".svn", ".hg", "build", "dist", "Pods",
  ".dart_tool", ".gradle", ".idea", ".vscode", "__pycache__", ".next",
  ".nuxt", "DerivedData", ".build", ".swiftpm", "vendor", ".pub-cache",
  "coverage", ".cache", ".pub", "windows", "linux", "web", "macos",
]);

/**
 * Read README file content
 */
export function readReadme(rootDir: string): string | null {
  for (const name of README_NAMES) {
    const content = readFileSafe(join(rootDir, name));
    if (content && content.trim().length > 0) {
      // Truncate to 10k chars to keep AI context manageable
      return content.substring(0, 10000);
    }
  }
  return null;
}

/**
 * Read relevant source code files for AI analysis
 * Returns a curated set of source code content, limited in size
 */
export function readSourceCode(
  rootDir: string,
  techStack: TechStack,
  maxTotalChars = 50000
): string {
  const extensions = getExtensionsForStack(techStack);
  const priorityPatterns = getPriorityPatternsForStack(techStack);

  // Find all source files
  const allFiles = scanDirectory(rootDir, {
    extensions,
    maxDepth: 8,
    maxFiles: 500,
  });

  // Sort by priority (important files first)
  const sorted = sortByPriority(allFiles, priorityPatterns);

  // Read files until we hit the char limit
  const parts: string[] = [];
  let totalChars = 0;

  for (const file of sorted) {
    if (totalChars >= maxTotalChars) break;

    const content = readFileSafe(join(rootDir, file));
    if (!content || content.trim().length < 20) continue;

    // Skip test files
    if (isTestFile(file)) continue;
    // Skip generated files
    if (isGeneratedFile(file, content)) continue;

    const truncated = content.substring(0, 15000); // Max 15k per file for thorough AI analysis
    parts.push(`--- ${file} ---\n${truncated}`);
    totalChars += truncated.length;
  }

  return parts.join("\n\n");
}

/**
 * Get file extensions to scan for each tech stack
 */
function getExtensionsForStack(techStack: TechStack): string[] {
  switch (techStack) {
    case "flutter":
      return [".dart"];
    case "swift":
      // .m/.mm (Objective-C) + .h added alongside .swift: the "swift" stack
      // now also covers ObjC-only iOS projects (see tech-detector.ts's
      // relabel to "iOS Native (Swift/Objective-C)").
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
      // Kotlin (shared/androidApp) + Swift (iosApp) - a KMP project's source
      // is split across both languages.
      return [".kt", ".kts", ".swift"];
    default:
      return [".ts", ".js", ".swift", ".dart", ".kt"];
  }
}

/**
 * Priority patterns - files matching these come first
 */
function getPriorityPatternsForStack(techStack: TechStack): string[] {
  const common = [
    "main",
    "app",
    "index",
    "home",
    "root",
    "navigation",
    "router",
    "config",
    "theme",
    "constants",
    "model",
    "service",
  ];

  switch (techStack) {
    case "flutter":
      return [...common, "widget", "screen", "page", "bloc", "provider", "controller"];
    case "swift":
      return [...common, "view", "controller", "manager", "delegate", "contentview"];
    case "kotlin":
      return [
        ...common,
        "activity", "fragment", "viewmodel", "repository",
        // Jetpack Compose deyimleri — Compose-first projelerde UI kodları
        // bunlar olmadan priority listesinde aşağı sıralanıyordu
        "composable", "screen", "theme", "navigation", "navgraph",
        "scaffold", "compose", "material",
      ];
    case "expo":
      return [...common, "screen", "component", "hook", "context", "store", "slice", "_layout", "tabs"];
    case "react-native":
    case "capacitor":
      return [...common, "screen", "component", "hook", "context", "store", "slice"];
    case "dotnet-maui":
      return [...common, "page", "view", "viewmodel", "service", "mauiprogram", "appshell"];
    case "unity":
      return [...common, "gamemanager", "main", "controller", "manager"];
    case "kmp":
      return [...common, "app", "mainactivity", "contentview", "viewmodel"];
    default:
      return common;
  }
}

/**
 * Sort files by priority (important files first)
 */
function sortByPriority(files: string[], patterns: string[]): string[] {
  return [...files].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    const aScore = patterns.reduce(
      (score, pattern) => (aLower.includes(pattern) ? score + 1 : score),
      0
    );
    const bScore = patterns.reduce(
      (score, pattern) => (bLower.includes(pattern) ? score + 1 : score),
      0
    );

    // Higher priority first
    if (aScore !== bScore) return bScore - aScore;
    // Shorter paths first (more likely to be important)
    return a.length - b.length;
  });
}

function isTestFile(file: string): boolean {
  const lower = file.toLowerCase();
  // Standard test directory segments (JVM: src/test/, src/androidTest/; JS: __tests__; general: tests/, spec/)
  if (
    /(?:^|[/\\])(?:test|tests|__tests__|spec|specs|androidtest|mocks?|fixtures?)[/\\]/.test(
      lower
    )
  ) {
    return true;
  }
  // File naming conventions:
  //   JS/TS: foo.test.ts, foo.spec.ts, foo.mock.ts, foo.fixture.ts
  //   JVM/Swift: FooTest.kt, FooTests.kt, FooSpec.kt
  // Avoids false positives on names that merely contain "test" as a substring
  // (LatestActivity.kt, ManifestLoader.kt, RequestHandler.kt).
  if (/\.(?:test|spec|mock|fixture)\.[a-z]+$/.test(lower)) return true;
  if (/(?:test|tests|spec|specs)\.[a-z]+$/.test(lower)) return true;
  return false;
}

function isGeneratedFile(file: string, content: string): boolean {
  const lower = file.toLowerCase();
  if (
    lower.includes(".g.dart") ||
    lower.includes(".freezed.dart") ||
    lower.includes(".gen.") ||
    lower.includes("generated")
  ) {
    return true;
  }

  // Check for generated file markers
  const firstLine = content.split("\n")[0] || "";
  return (
    firstLine.includes("GENERATED") ||
    firstLine.includes("DO NOT EDIT") ||
    firstLine.includes("AUTO-GENERATED")
  );
}

/**
 * Generate a visual project directory tree for AI context.
 * Shows the project structure up to a configurable depth, helping
 * the AI understand the app's architecture (screens, services, models, etc.)
 */
export function generateProjectTree(
  rootDir: string,
  maxDepth = 5,
  maxEntries = 300
): string {
  const lines: string[] = [];
  let entryCount = 0;

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth || entryCount >= maxEntries) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).sort((a, b) => {
        // Directories first
        const aIsDir = isDir(join(dir, a));
        const bIsDir = isDir(join(dir, b));
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });
    } catch {
      return;
    }

    // Filter out ignored entries
    entries = entries.filter((e) => {
      if (e.startsWith(".")) return false;
      if (TREE_IGNORE.has(e)) return false;
      return true;
    });

    for (let i = 0; i < entries.length; i++) {
      if (entryCount >= maxEntries) {
        lines.push(`${prefix}... (truncated)`);
        return;
      }

      const entry = entries[i];
      const fullPath = join(dir, entry);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (isDir(fullPath)) {
        lines.push(`${prefix}${connector}${entry}/`);
        entryCount++;
        walk(fullPath, prefix + childPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry}`);
        entryCount++;
      }
    }
  }

  function isDir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  // Start with project root name
  const rootName = relative(join(rootDir, ".."), rootDir) || "project";
  lines.push(`${rootName}/`);
  walk(rootDir, "", 0);

  return lines.join("\n");
}
