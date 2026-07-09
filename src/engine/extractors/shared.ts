// Shared helpers for the iOS/Android artifact extractors. Not an extractor
// itself - infra reused by ios-plist.ts, ios-entitlements.ts,
// ios-privacy-manifest.ts, android-manifest.ts and gradle-targets.ts.

/** Evidence fragment shape used by every extractor's return value. */
export type EvidenceMap = Record<string, { file: string; detail?: string }>;

// Known Xcode extension-target suffixes. Mirrors (does not import - these
// are private to that module) the EXTENSION_SUFFIXES list in
// src/analyzers/config-parser.ts so both places agree on what counts as
// "not the main app target".
export const EXTENSION_SUFFIXES = [
  "Extension", "Widget", "WidgetExtension", "Intent", "IntentExtension",
  "NotificationService", "NotificationContent", "ShieldConfiguration",
  "ShieldConfigurationExtension", "ShieldAction", "ShieldActionExtension",
  "WatchKit", "Watch", "Clip", "Tests", "UITests", "StickerPack",
  "ShareExtension", "TodayExtension", "KeyboardExtension",
];

/**
 * True when any directory segment of `relPath` (the filename itself is
 * excluded) looks like an Xcode extension target, e.g.
 * "MyApp/MyAppWidget/Info.plist" -> true because "MyAppWidget" ends with
 * "Widget".
 */
export function isExtensionPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  return segments.some((segment, idx) => {
    if (idx === segments.length - 1) return false; // filename, not a target dir
    if (!segment) return false;
    return EXTENSION_SUFFIXES.some(
      (suffix) =>
        segment.endsWith(suffix) ||
        segment.toLowerCase().endsWith(suffix.toLowerCase())
    );
  });
}

/** True when `value` is a string containing an unresolved Xcode build variable ($(...) or ${...}). */
export function isXcodeVariable(value: unknown): value is string {
  return typeof value === "string" && (value.includes("$(") || value.includes("${"));
}

/**
 * Normalizes a raw plist/build-setting value into the "string | null" shape
 * used throughout AppProfile.ios.plist: non-strings, empty strings, and
 * unresolved Xcode variables all collapse to null.
 */
export function normalizeStringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  if (isXcodeVariable(value)) return null;
  return value;
}

/**
 * Normalizes a boolean-typed plist fact that may arrive either as a real
 * boolean (plist.parse of <true/>/<false/>, or JSON from an Expo config) or
 * as a raw pbxproj build-setting string ("YES"/"NO"/"true"/"false"/"1"/"0",
 * any casing). Anything unrecognized -> null (unknown fact), never a guessed
 * boolean: Boolean("NO") === true is exactly the inversion this prevents.
 */
export function parsePlistBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "yes" || normalized === "true" || normalized === "1") return true;
    if (normalized === "no" || normalized === "false" || normalized === "0") return false;
  }
  return null;
}

/** Number of path segments in `relPath` - used to prefer shallower (closer to root) files. */
export function pathDepth(relPath: string): number {
  return relPath.split(/[\\/]/).length;
}
