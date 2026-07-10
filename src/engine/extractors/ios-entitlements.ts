import { relative } from "node:path";
import plistLib from "plist";
import { findFiles, readFileSafe } from "../../utils/file-scanner.js";
import type { AppProfile } from "../types.js";
import { isExtensionPath, type EvidenceMap } from "./shared.js";

export interface IosEntitlementsExtraction {
  entitlements: NonNullable<NonNullable<AppProfile["ios"]>["entitlements"]> | null;
  evidence: EvidenceMap;
}

/**
 * Extracts and unions facts across every *.entitlements file found (depth 5).
 * Extension-target entitlements (Widget/Watch/Clip/... - see shared.ts) are
 * preferred out of; but when the ONLY entitlements files found belong to
 * extensions, they are still used (an app can ship an extension with its own
 * entitlements even when the main target has none), with a note left in
 * evidence so callers know the facts came from a non-main target.
 */
export function extractIosEntitlements(rootDir: string): IosEntitlementsExtraction {
  const evidence: EvidenceMap = {};

  const allFiles = findFiles(rootDir, [".entitlements"], 5);
  if (allFiles.length === 0) {
    return { entitlements: null, evidence };
  }

  const nonExtensionFiles = allFiles.filter(
    (abs) => !isExtensionPath(relative(rootDir, abs))
  );
  const usedExtensionOnly = nonExtensionFiles.length === 0;
  const files = (usedExtensionOnly ? allFiles : nonExtensionFiles).sort();

  let apsEnvironment: string | null = null;
  const associatedDomains = new Set<string>();
  let healthkit = false;
  let signInWithApple = false;
  const appGroups = new Set<string>();
  const keys = new Set<string>();

  for (const file of files) {
    const content = readFileSafe(file);
    if (!content) continue;
    let parsed: Record<string, unknown>;
    try {
      const value = plistLib.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      parsed = value as Record<string, unknown>;
    } catch {
      continue; // Malformed XML: skip this file, keep merging the others.
    }

    for (const key of Object.keys(parsed)) keys.add(key);

    if (apsEnvironment === null) {
      const aps = parsed["aps-environment"];
      if (typeof aps === "string" && aps.length > 0) apsEnvironment = aps;
    }

    const domains = parsed["com.apple.developer.associated-domains"];
    if (Array.isArray(domains)) {
      for (const d of domains) if (typeof d === "string") associatedDomains.add(d);
    }

    if (parsed["com.apple.developer.healthkit"]) healthkit = true;

    const appleSignIn = parsed["com.apple.developer.applesignin"];
    if (Array.isArray(appleSignIn) && appleSignIn.length > 0) signInWithApple = true;

    const groups = parsed["com.apple.security.application-groups"];
    if (Array.isArray(groups)) {
      for (const g of groups) if (typeof g === "string") appGroups.add(g);
    }
  }

  evidence["ios.entitlements"] = {
    file: files.map((f) => relative(rootDir, f)).join(", "),
    detail: usedExtensionOnly
      ? `${files.length} extension-target entitlements file(s) - no main-target entitlements found`
      : `${files.length} entitlements file(s) merged`,
  };

  return {
    entitlements: {
      aps_environment: apsEnvironment,
      associated_domains: Array.from(associatedDomains).sort(),
      healthkit,
      sign_in_with_apple: signInWithApple,
      app_groups: Array.from(appGroups).sort(),
      keys: Array.from(keys).sort(),
    },
    evidence,
  };
}
