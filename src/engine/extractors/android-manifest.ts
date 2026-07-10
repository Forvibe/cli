import { join, relative } from "node:path";
import { fileExists, findAllFiles, readFileSafe } from "../../utils/file-scanner.js";
import type { AppProfile } from "../types.js";
import type { EvidenceMap } from "./shared.js";

export interface AndroidManifestExtraction {
  android: NonNullable<AppProfile["android"]>;
  evidence: EvidenceMap;
}

// Directory segments that mark an AndroidManifest.xml as NOT the main
// release manifest (build output, test sources, or a debug-only overlay).
const EXCLUDED_SEGMENTS = new Set(["build", "test", "androidTest", "debug"]);

function isExcludedManifestPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/**
 * Locates the main AndroidManifest.xml, trying the conventional module
 * layouts first, then falling back to any manifest found within depth 5
 * (excluding build output, test sources, and debug-variant overlays).
 */
function findMainManifest(rootDir: string): string | null {
  const knownCandidates = [
    join(rootDir, "app/src/main/AndroidManifest.xml"),
    join(rootDir, "android/app/src/main/AndroidManifest.xml"),
    join(rootDir, "src/main/AndroidManifest.xml"),
  ];
  for (const candidate of knownCandidates) {
    if (fileExists(candidate)) return candidate;
  }

  const found = findAllFiles(rootDir, "AndroidManifest.xml", 5).filter(
    (abs) => !isExcludedManifestPath(relative(rootDir, abs))
  );
  if (found.length === 0) return null;
  // Prefer the shallowest remaining candidate.
  return [...found].sort(
    (a, b) => relative(rootDir, a).split(/[\\/]/).length - relative(rootDir, b).split(/[\\/]/).length
  )[0];
}

function extractPermissions(content: string): string[] {
  const permissions = new Set<string>();
  const tagPattern = /<uses-permission(?:-sdk-23)?\b[^>]*>/g;
  const nameAttrPattern = /android:name\s*=\s*"([^"]+)"/;
  for (const tagMatch of content.matchAll(tagPattern)) {
    const nameMatch = tagMatch[0].match(nameAttrPattern);
    if (nameMatch) permissions.add(nameMatch[1]);
  }
  return Array.from(permissions).sort();
}

/**
 * Regex-based AndroidManifest.xml extraction (this repo's established
 * pattern for config parsing - no XML dependency).
 */
export function extractAndroidManifest(rootDir: string): AndroidManifestExtraction {
  const evidence: EvidenceMap = {};

  const manifestPath = findMainManifest(rootDir);
  if (!manifestPath) {
    return {
      android: {
        manifest_found: false,
        permissions: [],
        exported_components: 0,
        queries_declared: false,
      },
      evidence,
    };
  }

  const content = readFileSafe(manifestPath);
  if (!content) {
    return {
      android: {
        manifest_found: false,
        permissions: [],
        exported_components: 0,
        queries_declared: false,
      },
      evidence,
    };
  }

  evidence["android.manifest"] = { file: relative(rootDir, manifestPath) };

  const permissions = extractPermissions(content);
  const exportedComponents = (content.match(/android:exported\s*=\s*"true"/g) ?? []).length;
  const queriesDeclared = /<queries[\s>]/.test(content);

  return {
    android: {
      manifest_found: true,
      permissions,
      exported_components: exportedComponents,
      queries_declared: queriesDeclared,
    },
    evidence,
  };
}
