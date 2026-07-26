// The single source-reading path for the static engine.
//
// Why this module exists: the deterministic signal scan used to share the AI
// prompt's ~150KB character budget, which on a real Flutter app meant regexing
// 35 of 264 files and then reporting "not found" as a confident violation. A
// regex pass over text costs milliseconds; there is no reason for it to share a
// token budget with an LLM. This reader is deliberately budget-generous and
// reports exactly how complete its coverage was, so callers can tell the
// difference between "we looked everywhere and it isn't there" and "we ran out
// of room". Only the former may be reported as a failure.

import { statSync } from "node:fs";
import { join } from "node:path";
import { scanDirectory, readFileSafe } from "../utils/file-scanner.js";
import { isTestFile, isGeneratedFile } from "../analyzers/source-reader.js";
import type { TechStack } from "../types/report.js";

export interface CorpusFile {
  /** Path relative to the scanned root directory. */
  path: string;
  /** FULL file content. Never truncated: signals live at arbitrary offsets. */
  content: string;
}

export type CoverageLimit =
  | "max_files"
  | "max_bytes"
  | "walker_saturated"
  | "oversize_file"
  | "read_error";

export interface CorpusCoverage {
  /** Source files the walker found for this stack's extensions. */
  discovered: number;
  /** Files actually read into the corpus. */
  read: number;
  /** Dropped as test/generated/empty. Does NOT make coverage incomplete. */
  filtered: number;
  total_bytes: number;
  /** True when every discovered non-filtered file was read untruncated. */
  complete: boolean;
  limits_hit: CoverageLimit[];
}

export interface SourceCorpus {
  files: CorpusFile[];
  coverage: CorpusCoverage;
}

/** Backstop against a pathological monorepo, not a normal-project budget. */
export const CORPUS_MAX_FILES = 4000;
export const CORPUS_MAX_BYTES = 24 * 1024 * 1024;
/**
 * Per-file ceiling. Well above readFileSafe's 1MB default: god-service files
 * (a 95KB api_service.dart is common, and much larger exists) are exactly where
 * compliance code hides.
 */
export const CORPUS_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Source-file extensions per stack. Mirrors source-reader.ts's mapping WITHOUT
 * its budget/priority logic: the engine only needs raw content to regex for
 * behavioral signals.
 */
export function extensionsForStack(stack: TechStack): string[] {
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

/**
 * Reads every source file for the stack, untruncated, and reports coverage.
 *
 * Files are returned sorted by path so that both the corpus order and any
 * budget truncation are deterministic across runs and machines.
 */
export function readSourceCorpus(
  rootDir: string,
  stack: TechStack,
  opts: { maxFiles?: number; maxBytes?: number } = {}
): SourceCorpus {
  const maxFiles = opts.maxFiles ?? CORPUS_MAX_FILES;
  const maxBytes = opts.maxBytes ?? CORPUS_MAX_BYTES;
  const limits = new Set<CoverageLimit>();

  // Ask for one more than the cap so an exactly-saturated walk is
  // distinguishable from a walk that simply found that many files.
  const relPaths = scanDirectory(rootDir, {
    extensions: extensionsForStack(stack),
    maxDepth: 8,
    maxFiles: maxFiles + 1,
  }).sort();

  let discovered = relPaths.length;
  let paths = relPaths;
  if (discovered > maxFiles) {
    limits.add("walker_saturated");
    limits.add("max_files");
    paths = relPaths.slice(0, maxFiles);
    discovered = maxFiles;
  }

  const files: CorpusFile[] = [];
  let filtered = 0;
  let totalBytes = 0;

  for (const rel of paths) {
    if (totalBytes >= maxBytes) {
      limits.add("max_bytes");
      break;
    }

    const abs = join(rootDir, rel);
    const content = readFileSafe(abs, CORPUS_MAX_FILE_BYTES);
    if (content === null) {
      // Either above the per-file ceiling or unreadable. Both mean we cannot
      // assert anything about this file's contents, so coverage is incomplete.
      let oversize = false;
      try {
        oversize = statSync(abs).size > CORPUS_MAX_FILE_BYTES;
      } catch {
        oversize = false;
      }
      limits.add(oversize ? "oversize_file" : "read_error");
      continue;
    }

    if (content.trim().length < 20 || isTestFile(rel) || isGeneratedFile(rel, content)) {
      filtered += 1;
      continue;
    }

    files.push({ path: rel, content });
    totalBytes += content.length;
  }

  // Files dropped by the walker/byte budget that we never even attempted.
  const attempted = files.length + filtered;
  const complete = limits.size === 0 && attempted === discovered;

  return {
    files,
    coverage: {
      discovered,
      read: files.length,
      filtered,
      total_bytes: totalBytes,
      complete,
      limits_hit: Array.from(limits).sort(),
    },
  };
}
