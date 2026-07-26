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

export interface SourceFile {
  /** Path relative to the scanned root directory. */
  path: string;
  /** File content, truncated to the per-file cap. */
  content: string;
}

/**
 * Reads the curated, budgeted source corpus as individual files. This is the
 * primitive behind readSourceCode(); the review command uses it directly so
 * the static engine's signal scan and the AI prompt operate on the exact same
 * corpus (same priority order, same per-file and total budgets).
 */
export function readSourceFiles(
  rootDir: string,
  techStack: TechStack,
  maxTotalChars = 50000
): SourceFile[] {
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
  const files: SourceFile[] = [];
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
    files.push({ path: file, content: truncated });
    totalChars += truncated.length;
  }

  return files;
}

/**
 * Joins a SourceFile corpus into the single `--- path ---` delimited string
 * shape the AI prompts consume.
 */
export function joinSourceFiles(files: SourceFile[]): string {
  return files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
}

/**
 * Read relevant source code files for AI analysis
 * Returns a curated set of source code content, limited in size
 * (Byte-identical to the pre-v2 implementation: readSourceFiles + join.)
 */
export function readSourceCode(
  rootDir: string,
  techStack: TechStack,
  maxTotalChars = 50000
): string {
  return joinSourceFiles(readSourceFiles(rootDir, techStack, maxTotalChars));
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
export function getPriorityPatternsForStack(techStack: TechStack): string[] {
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
      // "view"/"viewmodel"/"settings"/"auth"/"onboarding" were missing while
      // the swift list had "view", which is why lib/features/settings/view/
      // settings_view.dart scored ZERO on a Flutter app and never made it into
      // the prompt, despite holding the account-deletion, privacy-policy and
      // restore-purchases flows.
      return [
        ...common,
        "widget", "screen", "page", "bloc", "provider", "controller",
        "view", "viewmodel", "settings", "auth", "onboarding",
      ];
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

/** Files any single directory may contribute before others get a turn. */
const MAX_PER_DIR = 4;

/**
 * Scores one file. The BASENAME dominates; a directory match is only a weak
 * hint.
 *
 * The previous version counted pattern hits anywhere in the full path, which
 * made scoring degenerate: on a Flutter app every file under
 * lib/features/home/widget/ scored 2 (for "home" and "widget", both directory
 * names) while lib/main.dart scored 1, so one feature folder outranked the
 * entry point and consumed the whole budget.
 */
function scoreFile(rel: string, patterns: string[]): number {
  const lower = rel.toLowerCase();
  const slash = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  const dir = slash >= 0 ? lower.slice(0, slash) : "";

  let score = 0;
  for (const p of patterns) {
    if (base.includes(p)) score += 3;
    else if (dir.includes(p)) score += 1;
  }
  // Shallower files are likelier to be entry points; cap so deep-but-relevant
  // files are not buried outright.
  return score - Math.min(rel.split(/[/\\]/).length - 1, 6);
}

/**
 * Sort files by priority (important files first), with a per-directory quota
 * so that no single folder can monopolise a caller's budget.
 */
export function sortByPriority(files: string[], patterns: string[]): string[] {
  const ranked = [...files].sort((a, b) => {
    const d = scoreFile(b, patterns) - scoreFile(a, patterns);
    if (d !== 0) return d;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });

  // Round-robin the quota: take up to MAX_PER_DIR per directory in rank order,
  // then append everything that overflowed (still in rank order).
  const perDir = new Map<string, number>();
  const primary: string[] = [];
  const overflow: string[] = [];
  for (const file of ranked) {
    const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
    const dir = slash >= 0 ? file.slice(0, slash) : "";
    const used = perDir.get(dir) ?? 0;
    if (used < MAX_PER_DIR) {
      perDir.set(dir, used + 1);
      primary.push(file);
    } else {
      overflow.push(file);
    }
  }
  return [...primary, ...overflow];
}

export function isTestFile(file: string): boolean {
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

export function isGeneratedFile(file: string, content: string): boolean {
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
