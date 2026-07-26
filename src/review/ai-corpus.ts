// Chooses which files go into the AI reviewer's prompt.
//
// The old selection was a generic "important app files" heuristic: score each
// path by how many stack keywords it contained, take files until the character
// budget ran out. On a real Flutter app that filled the entire budget with one
// feature folder and never read main.dart, let alone the settings screen where
// account deletion, the privacy policy link and restore purchases all live.
//
// Now that the deterministic scan reads every file first, we already know which
// files contain compliance-relevant code. So evidence leads, and the generic
// heuristic only fills whatever budget is left.

import type { SourceFile } from "../analyzers/source-reader.js";
import { sortByPriority, getPriorityPatternsForStack } from "../analyzers/source-reader.js";
import type { SourceCorpus } from "../engine/source-corpus.js";
import type { SignalHit } from "../engine/profile-builder.js";
import type { TechStack } from "../types/report.js";

export interface AiCorpusSelection {
  files: SourceFile[];
  /** EVERY discovered path, regardless of budget. */
  inventory: string[];
  totalChars: number;
  evidenceFileCount: number;
  selectedFrom: number;
}

/** Chars of context kept on each side of a signal match. */
const EXCERPT_RADIUS = 3000;
/** Share of the budget evidence files may consume, so they cannot crowd out everything else. */
const EVIDENCE_BUDGET_SHARE = 0.4;

/**
 * Extracts the regions of `content` around `offsets`, merging overlaps.
 *
 * Head-truncating a file to its first N chars is useless for evidence: the
 * `deleteAccount` that proves an app is compliant sits at line 1186 of a 95KB
 * service file. Selecting that file only helps if the excerpt actually contains
 * the match.
 */
export function excerptAround(
  content: string,
  offsets: number[],
  maxChars: number,
  radius = EXCERPT_RADIUS
): string {
  if (content.length <= maxChars) return content;

  const windows = offsets
    .map((o) => ({
      start: Math.max(0, o - radius),
      end: Math.min(content.length, o + radius),
    }))
    .sort((a, b) => a.start - b.start);

  // Merge overlapping/adjacent windows.
  const merged: { start: number; end: number }[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }

  const parts: string[] = [];
  let used = 0;
  let prevEnd = 0;
  for (const w of merged) {
    if (used >= maxChars) break;
    const slice = content.slice(w.start, Math.min(w.end, w.start + (maxChars - used)));
    if (w.start > prevEnd) {
      parts.push(`\n// ... [${w.start - prevEnd} chars omitted] ...\n`);
    }
    parts.push(slice);
    used += slice.length;
    prevEnd = w.start + slice.length;
  }
  if (prevEnd < content.length) {
    parts.push(`\n// ... [${content.length - prevEnd} chars omitted] ...\n`);
  }

  return parts.join("");
}

/**
 * Builds the AI prompt corpus: evidence files first (as match-centred
 * excerpts), then a generic priority fill, plus the complete file inventory.
 */
export function selectAiCorpus(
  corpus: SourceCorpus,
  hits: SignalHit[],
  stack: TechStack,
  maxTotalChars: number,
  perFileChars = 15000
): AiCorpusSelection {
  const byPath = new Map(corpus.files.map((f) => [f.path, f]));
  const inventory = corpus.files.map((f) => f.path);

  // --- Tier 1: files where the deterministic scan actually matched something.
  const hitsByPath = new Map<string, { signals: Set<string>; offsets: number[] }>();
  for (const hit of hits) {
    if (!byPath.has(hit.path)) continue;
    let entry = hitsByPath.get(hit.path);
    if (!entry) {
      entry = { signals: new Set(), offsets: [] };
      hitsByPath.set(hit.path, entry);
    }
    entry.signals.add(hit.signal);
    entry.offsets.push(hit.index);
  }

  const evidencePaths = Array.from(hitsByPath.entries())
    .sort((a, b) => {
      const d = b[1].signals.size - a[1].signals.size;
      return d !== 0 ? d : a[0].localeCompare(b[0]);
    })
    .map(([path]) => path);

  const files: SourceFile[] = [];
  const taken = new Set<string>();
  let totalChars = 0;

  const evidenceBudget = Math.floor(maxTotalChars * EVIDENCE_BUDGET_SHARE);
  for (const path of evidencePaths) {
    if (totalChars >= evidenceBudget) break;
    const file = byPath.get(path);
    if (!file) continue;
    const entry = hitsByPath.get(path);
    const content = excerptAround(file.content, entry?.offsets ?? [0], perFileChars);
    files.push({ path, content });
    taken.add(path);
    totalChars += content.length;
  }
  const evidenceFileCount = files.length;

  // --- Tier 2: generic priority fill for whatever budget remains.
  const remaining = corpus.files.filter((f) => !taken.has(f.path)).map((f) => f.path);
  const sorted = sortByPriority(remaining, getPriorityPatternsForStack(stack));

  for (const path of sorted) {
    if (totalChars >= maxTotalChars) break;
    const file = byPath.get(path);
    if (!file) continue;
    const content = file.content.substring(0, perFileChars);
    files.push({ path, content });
    taken.add(path);
    totalChars += content.length;
  }

  return {
    files,
    inventory,
    totalChars,
    evidenceFileCount,
    selectedFrom: corpus.files.length,
  };
}

/** Renders the full file list for the prompt, so absence is checkable. */
export function formatInventory(inventory: string[]): string {
  return inventory.join("\n");
}
