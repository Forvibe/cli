// SDK registry matcher: compares a project's raw, unfiltered dependency
// surface (EcosystemDeps, produced by collectRawDependencies() in
// ../analyzers/sdk-scanner.ts) against SDK registry entries (data-driven
// content, loaded elsewhere via the rulepack bundle) to produce the
// ProfileSDK list the rule engine consumes.
//
// Matching semantics (authoritative spec: rsv2-task-3b-brief.md):
//   - Default (npm, pub, nuget, upm): exact match; a pattern ending in "*"
//     is a prefix match (e.g. "firebase_*" matches "firebase_core").
//   - pods / spm: same default mechanism, but case-insensitive - spm
//     patterns are additionally compared against slugs the collector has
//     already lowercased (see collectSpmSlugs in sdk-scanner.ts).
//   - gradle: a "group:artifact" pattern matches a "group:artifact" dep
//     exactly; a bare-artifact pattern matches a bare-artifact dep OR the
//     artifact segment of a "group:artifact" dep. Case-sensitive, no "*"
//     wildcard (not part of this ecosystem's spec).
//   - ios_imports / android_imports: pattern is a module/package prefix,
//     matched at a segment (".") boundary: dep === pattern, or
//     dep.startsWith(pattern + "."). NOT the generic "*" mechanism - e.g.
//     "Stripe" matches "Stripe" and "Stripe.Charge" but never "StripeFake"
//     (no boundary between "Stripe" and "Fake").

import type { EcosystemDeps, ProfileSDK, SDKRegistryEntry } from "./types.js";

export interface RegistryMatch {
  sdks: ProfileSDK[];
}

type EcosystemKey = keyof SDKRegistryEntry["match"];

const ECOSYSTEM_KEYS: EcosystemKey[] = [
  "npm",
  "pub",
  "pods",
  "spm",
  "gradle",
  "nuget",
  "upm",
  "ios_imports",
  "android_imports",
];

/** Exact match by default; a pattern ending in "*" is a prefix match. Optionally case-insensitive. */
function matchDefault(pattern: string, dep: string, caseInsensitive: boolean): boolean {
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  const d = caseInsensitive ? dep.toLowerCase() : dep;
  if (p.endsWith("*")) return d.startsWith(p.slice(0, -1));
  return d === p;
}

/**
 * Gradle coordinate matching: a "group:artifact" pattern must match a dep of
 * that exact same full form. A bare-artifact pattern (no ":") matches either
 * a bare dep of the same name, or the artifact segment (substring after the
 * last ":") of a "group:artifact" dep. Case-sensitive; no "*" wildcard.
 */
function matchGradle(pattern: string, dep: string): boolean {
  if (pattern.includes(":")) return dep === pattern;
  if (dep === pattern) return true;
  const idx = dep.lastIndexOf(":");
  return idx >= 0 && dep.slice(idx + 1) === pattern;
}

/**
 * Import/package prefix matching at a segment (".") boundary. Case-sensitive
 * (import/package identifiers are case-sensitive in both Swift and
 * Kotlin/Java).
 */
function matchImportPrefix(pattern: string, dep: string): boolean {
  return dep === pattern || dep.startsWith(`${pattern}.`);
}

function ecosystemMatches(key: EcosystemKey, pattern: string, dep: string): boolean {
  switch (key) {
    case "gradle":
      return matchGradle(pattern, dep);
    case "ios_imports":
    case "android_imports":
      return matchImportPrefix(pattern, dep);
    case "pods":
    case "spm":
      return matchDefault(pattern, dep, true);
    default:
      return matchDefault(pattern, dep, false);
  }
}

/**
 * Matches a project's raw dependency surface against SDK registry entries.
 * Pure function, no filesystem access. Produces at most one ProfileSDK per
 * registry entry (coordinates matched via different ecosystem keys for the
 * same entry are merged into that one entry's matched_coordinates); output
 * sorted by id.
 */
export function matchSDKs(deps: EcosystemDeps, registry: SDKRegistryEntry[]): ProfileSDK[] {
  const results: ProfileSDK[] = [];

  for (const entry of registry) {
    const coordinates = new Set<string>();

    for (const key of ECOSYSTEM_KEYS) {
      const patterns = entry.match[key];
      if (!patterns || patterns.length === 0) continue;
      const bucket = deps[key];
      if (!bucket || bucket.length === 0) continue;

      for (const pattern of patterns) {
        for (const dep of bucket) {
          if (ecosystemMatches(key, pattern, dep)) {
            coordinates.add(`${key}:${dep}`);
          }
        }
      }
    }

    if (coordinates.size > 0) {
      results.push({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        matched_coordinates: Array.from(coordinates).sort(),
        data_collection: entry.data_collection,
        flags: entry.flags,
      });
    }
  }

  return results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
