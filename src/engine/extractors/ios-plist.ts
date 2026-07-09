import { join, relative } from "node:path";
import plistLib from "plist";
import { findAllFiles, findFile, readFileSafe } from "../../utils/file-scanner.js";
import type { AppProfile } from "../types.js";
import {
  isExtensionPath,
  normalizeStringValue,
  parsePlistBoolean,
  pathDepth,
  type EvidenceMap,
} from "./shared.js";

export interface IosPlistExtraction {
  plist_source: "plist_file" | "pbxproj_infoplist_keys" | "expo_config" | "merged" | "none";
  plist: NonNullable<NonNullable<AppProfile["ios"]>["plist"]> | null;
  evidence: EvidenceMap;
}

type PlistFieldValue = NonNullable<IosPlistExtraction["plist"]>;

// Keys already represented by a named AppProfile.ios.plist field, kept out
// of `other_keys`. NSAppTransportSecurity/GADApplicationIdentifier/etc are
// listed explicitly; anything matching /UsageDescription$/ is excluded by
// the regex check instead of by name (there are dozens of NS*UsageDescription keys).
const NAMED_FIELD_KEYS = new Set([
  "UIBackgroundModes",
  "NSAppTransportSecurity",
  "GADApplicationIdentifier",
  "SKAdNetworkItems",
  "ITSAppUsesNonExemptEncryption",
  "UIRequiredDeviceCapabilities",
]);

/**
 * Locates the main app target's Info.plist: any Info.plist within depth 4,
 * excluding extension-target paths (Widget/Watch/Clip/Tests/... - see
 * shared.ts). When more than one non-extension candidate exists, the
 * shallowest path (closest to rootDir) is assumed to be the main target.
 */
function findMainInfoPlist(rootDir: string): string | null {
  const candidates = findAllFiles(rootDir, "Info.plist", 4);
  const nonExtension = candidates.filter(
    (abs) => !isExtensionPath(relative(rootDir, abs))
  );
  if (nonExtension.length === 0) return null;
  return [...nonExtension].sort(
    (a, b) => pathDepth(relative(rootDir, a)) - pathDepth(relative(rootDir, b))
  )[0];
}

/** Reads and parses an Info.plist file. Returns null if missing, unreadable, or malformed. */
function readInfoPlistFile(filePath: string): Record<string, unknown> | null {
  const content = readFileSafe(filePath);
  if (!content) return null;
  try {
    const parsed = plistLib.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // Malformed XML: treat this source as absent rather than throwing.
    return null;
  }
}

/** Collects INFOPLIST_KEY_<Name> = <value>; build settings from a project.pbxproj. */
function readPbxprojInfoplistKeys(
  content: string
): { keys: Record<string, string>; generatesInfoPlist: boolean } {
  const keys: Record<string, string> = {};
  const keyPattern = /INFOPLIST_KEY_([A-Za-z0-9_]+)\s*=\s*"?([^";]+)"?;/g;
  for (const match of content.matchAll(keyPattern)) {
    keys[match[1]] = match[2].trim();
  }
  const generatesInfoPlist = /GENERATE_INFOPLIST_FILE\s*=\s*YES/.test(content);
  return { keys, generatesInfoPlist };
}

/** Best-effort extraction from a non-JSON Expo config (app.config.js/app.config.ts). */
function readExpoConfigFallback(content: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of content.matchAll(
    /(NS[A-Za-z]+UsageDescription)\s*:\s*["']([^"']*)["']/g
  )) {
    found[m[1]] = m[2];
  }
  const gad = content.match(/GADApplicationIdentifier\s*:\s*["']([^"']*)["']/);
  if (gad) found.GADApplicationIdentifier = gad[1];
  return found;
}

function extractPlistFields(merged: Record<string, unknown>): PlistFieldValue {
  const usageDescriptions: Record<string, string | null> = {};
  for (const key of Object.keys(merged)) {
    if (/UsageDescription$/.test(key)) {
      usageDescriptions[key] = normalizeStringValue(merged[key]);
    }
  }

  const backgroundModes = Array.isArray(merged.UIBackgroundModes)
    ? merged.UIBackgroundModes.filter((v): v is string => typeof v === "string")
    : [];

  // ATS is a nested dict, so it cannot arrive from the pbxproj source
  // (INFOPLIST_KEY_* values are flat strings; a string never passes the
  // typeof-object guard below). parsePlistBoolean is still used for the
  // inner flag to tolerate stringly-typed values from Expo configs.
  let atsAllowsArbitraryLoads: boolean | null = null;
  const ats = merged.NSAppTransportSecurity;
  if (ats && typeof ats === "object" && !Array.isArray(ats)) {
    const atsDict = ats as Record<string, unknown>;
    if ("NSAllowsArbitraryLoads" in atsDict) {
      atsAllowsArbitraryLoads = parsePlistBoolean(atsDict.NSAllowsArbitraryLoads);
    }
  }

  const gadApplicationIdentifier = normalizeStringValue(merged.GADApplicationIdentifier);

  const skAdNetworkCount = Array.isArray(merged.SKAdNetworkItems)
    ? merged.SKAdNetworkItems.length
    : 0;

  // Key absent -> null (schema semantics). Key present -> parsePlistBoolean,
  // because from the pbxproj source this value is a raw string ("NO" must
  // map to false, not Boolean("NO") === true); unparseable -> null (unknown).
  let nonExemptEncryption: boolean | null = null;
  if ("ITSAppUsesNonExemptEncryption" in merged) {
    nonExemptEncryption = parsePlistBoolean(merged.ITSAppUsesNonExemptEncryption);
  }

  const requiredDeviceCapabilities = Array.isArray(merged.UIRequiredDeviceCapabilities)
    ? merged.UIRequiredDeviceCapabilities.filter((v): v is string => typeof v === "string")
    : [];

  const otherKeys = Array.from(
    new Set(
      Object.keys(merged).filter(
        (k) => !NAMED_FIELD_KEYS.has(k) && !/UsageDescription$/.test(k)
      )
    )
  ).sort();

  return {
    usage_descriptions: usageDescriptions,
    background_modes: backgroundModes,
    ats_allows_arbitrary_loads: atsAllowsArbitraryLoads,
    gad_application_identifier: gadApplicationIdentifier,
    sk_ad_network_count: skAdNetworkCount,
    non_exempt_encryption: nonExemptEncryption,
    required_device_capabilities: requiredDeviceCapabilities,
    other_keys: otherKeys,
  };
}

/**
 * Extracts the merged iOS Info.plist facts from up to three sources: a real
 * Info.plist file, INFOPLIST_KEY_* build settings in project.pbxproj, and an
 * Expo config's expo.ios.infoPlist block.
 *
 * Merge precedence when sources overlap on the same key: Info.plist file >
 * pbxproj INFOPLIST_KEY_* keys > Expo config. Implemented by spreading the
 * lowest-precedence source first so higher-precedence sources overwrite it.
 */
export function extractIosPlist(rootDir: string): IosPlistExtraction {
  const evidence: EvidenceMap = {};

  // ---- Source 1: Info.plist file ----
  const plistFilePath = findMainInfoPlist(rootDir);
  const plistFileData = plistFilePath ? readInfoPlistFile(plistFilePath) : null;
  if (plistFilePath && plistFileData) {
    evidence["ios.plist.plist_file"] = { file: relative(rootDir, plistFilePath) };
  }

  // ---- Source 2: pbxproj INFOPLIST_KEY_* build settings ----
  const pbxprojPath = findFile(rootDir, "project.pbxproj", 5);
  let pbxprojData: Record<string, string> | null = null;
  if (pbxprojPath) {
    const content = readFileSafe(pbxprojPath);
    if (content) {
      const { keys, generatesInfoPlist } = readPbxprojInfoplistKeys(content);
      if (Object.keys(keys).length > 0 || generatesInfoPlist) {
        pbxprojData = keys;
        evidence["ios.plist.pbxproj_infoplist_keys"] = {
          file: relative(rootDir, pbxprojPath),
          detail: generatesInfoPlist ? "GENERATE_INFOPLIST_FILE = YES" : undefined,
        };
      }
    }
  }

  // ---- Source 3: Expo config ----
  let expoData: Record<string, unknown> | null = null;
  const appJsonContent = readFileSafe(join(rootDir, "app.json"));
  if (appJsonContent) {
    try {
      const appJson = JSON.parse(appJsonContent);
      const infoPlist = appJson?.expo?.ios?.infoPlist;
      if (infoPlist && typeof infoPlist === "object" && !Array.isArray(infoPlist)) {
        expoData = infoPlist as Record<string, unknown>;
        evidence["ios.plist.expo_config"] = { file: "app.json" };
      }
    } catch {
      // Malformed app.json: ignore, fall through to app.config.js/ts.
    }
  }
  if (!expoData) {
    for (const name of ["app.config.ts", "app.config.js"]) {
      const content = readFileSafe(join(rootDir, name));
      if (!content) continue;
      const found = readExpoConfigFallback(content);
      if (Object.keys(found).length > 0) {
        expoData = found;
        evidence["ios.plist.expo_config"] = {
          file: name,
          detail: "best-effort regex extraction (app.config.js/ts)",
        };
      }
      break; // only the first of app.config.ts / app.config.js that exists
    }
  }

  const contributing: Array<"plist_file" | "pbxproj_infoplist_keys" | "expo_config"> = [];
  if (expoData) contributing.push("expo_config");
  if (pbxprojData) contributing.push("pbxproj_infoplist_keys");
  if (plistFileData) contributing.push("plist_file");

  if (contributing.length === 0) {
    return { plist_source: "none", plist: null, evidence };
  }

  const merged: Record<string, unknown> = {
    ...(expoData ?? {}),
    ...(pbxprojData ?? {}),
    ...(plistFileData ?? {}),
  };

  return {
    plist_source: contributing.length > 1 ? "merged" : contributing[0],
    plist: extractPlistFields(merged),
    evidence,
  };
}
