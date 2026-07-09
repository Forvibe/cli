import { relative } from "node:path";
import plistLib from "plist";
import { findAllFiles, readFileSafe } from "../../utils/file-scanner.js";
import type { AppProfile } from "../types.js";
import { pathDepth, type EvidenceMap } from "./shared.js";

export interface IosPrivacyManifestExtraction {
  privacy_manifest: NonNullable<NonNullable<AppProfile["ios"]>["privacy_manifest"]>;
  evidence: EvidenceMap;
}

function emptyPrivacyManifest(): IosPrivacyManifestExtraction["privacy_manifest"] {
  return {
    app_manifest_present: false,
    collected_data_types: [],
    accessed_api_types: [],
    tracking: null,
    tracking_domains: [],
    sdk_manifests_found: 0,
  };
}

/**
 * Extracts Apple Privacy Manifest (PrivacyInfo.xcprivacy) facts. Searches by
 * exact filename (depth 6) rather than by extension, since that literal
 * filename is the only one Apple's tooling recognizes - app target and
 * vendored SDK manifests are indistinguishable by name alone.
 *
 * NOTE: SPM/CocoaPods SDK manifests usually live under Pods/ or similar
 * dependency directories, which the file-scanner walker already ignores.
 * `sdk_manifests_found` therefore only counts what is actually visible in
 * the scanned tree, not the true number of SDK manifests bundled with the app.
 */
export function extractIosPrivacyManifest(rootDir: string): IosPrivacyManifestExtraction {
  const evidence: EvidenceMap = {};

  const allFiles = findAllFiles(rootDir, "PrivacyInfo.xcprivacy", 6);
  if (allFiles.length === 0) {
    return { privacy_manifest: emptyPrivacyManifest(), evidence };
  }

  // Shortest path (closest to rootDir) is assumed to be the app's own manifest.
  const sorted = [...allFiles].sort(
    (a, b) => pathDepth(relative(rootDir, a)) - pathDepth(relative(rootDir, b))
  );
  const appManifestPath = sorted[0];
  const otherCount = sorted.length - 1;

  evidence["ios.privacy_manifest"] = { file: relative(rootDir, appManifestPath) };
  if (otherCount > 0) {
    evidence["ios.privacy_manifest.sdk_manifests_found"] = {
      file: sorted
        .slice(1)
        .map((f) => relative(rootDir, f))
        .join(", "),
      detail: `${otherCount} other .xcprivacy file(s) visible in the scanned tree`,
    };
  }

  const content = readFileSafe(appManifestPath);
  let parsed: Record<string, unknown> | null = null;
  if (content) {
    try {
      const value = plistLib.parse(content);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // Malformed app manifest: the file is present, but its contents
      // cannot be read - fields fall back to empty defaults below.
      parsed = null;
    }
  }

  if (!parsed) {
    return {
      privacy_manifest: { ...emptyPrivacyManifest(), app_manifest_present: true, sdk_manifests_found: otherCount },
      evidence,
    };
  }

  const collectedDataTypes: string[] = [];
  if (Array.isArray(parsed.NSPrivacyCollectedDataTypes)) {
    for (const entry of parsed.NSPrivacyCollectedDataTypes) {
      if (entry && typeof entry === "object") {
        const type = (entry as Record<string, unknown>).NSPrivacyCollectedDataType;
        if (typeof type === "string") collectedDataTypes.push(type);
      }
    }
  }

  const accessedApiTypes: string[] = [];
  if (Array.isArray(parsed.NSPrivacyAccessedAPITypes)) {
    for (const entry of parsed.NSPrivacyAccessedAPITypes) {
      if (entry && typeof entry === "object") {
        const type = (entry as Record<string, unknown>).NSPrivacyAccessedAPIType;
        if (typeof type === "string") accessedApiTypes.push(type);
      }
    }
  }

  const tracking = "NSPrivacyTracking" in parsed ? Boolean(parsed.NSPrivacyTracking) : null;

  const trackingDomains = Array.isArray(parsed.NSPrivacyTrackingDomains)
    ? parsed.NSPrivacyTrackingDomains.filter((v): v is string => typeof v === "string")
    : [];

  return {
    privacy_manifest: {
      app_manifest_present: true,
      collected_data_types: collectedDataTypes,
      accessed_api_types: accessedApiTypes,
      tracking,
      tracking_domains: trackingDomains,
      sdk_manifests_found: otherCount,
    },
    evidence,
  };
}
