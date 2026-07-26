import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

// Directories and files to always ignore
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "build",
  "dist",
  "Pods",
  ".dart_tool",
  ".gradle",
  ".idea",
  ".vscode",
  "__pycache__",
  ".next",
  ".nuxt",
  "DerivedData",
  ".build",
  ".swiftpm",
  "vendor",
  ".pub-cache",
  "coverage",
  ".cache",
]);

const IGNORE_EXTENSIONS = new Set([
  ".lock",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".pdf",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

/**
 * Check if a file/directory should be ignored
 */
function shouldIgnore(name: string): boolean {
  if (name.startsWith(".") && name !== ".env" && name !== ".gitignore") {
    return true;
  }
  return IGNORE_DIRS.has(name);
}

/**
 * Recursively scan a directory for files matching patterns
 */
export function scanDirectory(
  rootDir: string,
  options: {
    maxDepth?: number;
    extensions?: string[];
    fileNames?: string[];
    maxFiles?: number;
  } = {}
): string[] {
  const { maxDepth = 10, extensions, fileNames, maxFiles = 5000 } = options;
  const files: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth || files.length >= maxFiles) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (shouldIgnore(entry)) continue;

      const fullPath = join(dir, entry);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const ext = entry.substring(entry.lastIndexOf(".")).toLowerCase();
        if (IGNORE_EXTENSIONS.has(ext)) continue;

        if (extensions && !extensions.some((e) => entry.endsWith(e))) continue;
        if (fileNames && !fileNames.includes(entry)) continue;

        files.push(relative(rootDir, fullPath));
      }
    }
  }

  walk(rootDir, 0);
  return files;
}

/**
 * Find a specific file by name in the project
 */
export function findFile(
  rootDir: string,
  fileName: string,
  maxDepth = 5
): string | null {
  const results = scanDirectory(rootDir, {
    fileNames: [fileName],
    maxDepth,
    maxFiles: 1,
  });
  return results.length > 0 ? join(rootDir, results[0]) : null;
}

/**
 * Find ALL files with a given name in the project (not just the first)
 */
export function findAllFiles(
  rootDir: string,
  fileName: string,
  maxDepth = 5
): string[] {
  const results = scanDirectory(rootDir, {
    fileNames: [fileName],
    maxDepth,
    maxFiles: 50,
  });
  return results.map((f) => join(rootDir, f));
}

/**
 * Find files matching a glob-like pattern
 */
export function findFiles(
  rootDir: string,
  extensions: string[],
  maxDepth = 5
): string[] {
  return scanDirectory(rootDir, { extensions, maxDepth }).map((f) =>
    join(rootDir, f)
  );
}

/** Default size above which readFileSafe refuses to read a file. */
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

/**
 * Read a file safely, returning null on error.
 *
 * `maxBytes` defaults to 1MB, which is the right guard for the many callers
 * that read a single config/manifest file. The source-corpus reader raises it
 * deliberately: compliance code (deleteAccount, restorePurchases) frequently
 * lives in oversized god-service files, and silently dropping those is how the
 * signal scan used to produce false "not found" results.
 */
export function readFileSafe(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES
): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (stat.size > maxBytes) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Check if a file exists
 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
