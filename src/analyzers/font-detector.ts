import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, extname, basename } from "path";
import yaml from "yaml";
import plist from "plist";
import type { TechStack } from "../types/report.js";
import { findFiles, readFileSafe } from "../utils/file-scanner.js";

const SYSTEM_FONTS = new Set([
  "system", "sans-serif", "serif", "monospace", "cursive", "fantasy",
  "sans-serif-medium", "sans-serif-light", "sans-serif-thin", "sans-serif-black",
  "sans-serif-condensed", "sans-serif-smallcaps",
  "sf pro", "sf pro text", "sf pro display", "sf pro rounded",
  "sf compact", "sf mono", "new york",
  "helvetica", "helvetica neue", "arial", "times new roman", "courier",
  "roboto", // Android system font — usually not a brand choice
]);

const WEIGHT_SUFFIXES = /[-_ ]?(Regular|Bold|Italic|Light|Medium|SemiBold|ExtraBold|Thin|Black|Heavy|Book|Condensed|Expanded|ExtraLight|UltraLight|UltraBold|DemiBold|Oblique|Roman|Normal|Variable|Display|Text|Mono)\b/gi;

function cleanFontName(raw: string): string {
  let name = raw.replace(/\.(ttf|otf|woff2?|eot)$/i, "");
  name = name.replace(WEIGHT_SUFFIXES, "");
  name = name.replace(/[-_]/g, " ").trim();
  // Title case each word
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());
  // Clean up multiple spaces
  name = name.replace(/\s+/g, " ").trim();
  return name;
}

function camelToTitleCase(camel: string): string {
  return camel
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (s) => s.toUpperCase());
}

function fontNameFromFile(fileName: string): string {
  return cleanFontName(basename(fileName));
}

/**
 * Scan a directory for font files (.ttf, .otf)
 */
function scanForFontFiles(dir: string, maxDepth = 3): string[] {
  const fonts: string[] = [];

  function walk(d: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(d);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const fullPath = join(d, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else {
            const ext = extname(entry).toLowerCase();
            if (ext === ".ttf" || ext === ".otf") {
              fonts.push(entry);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  if (existsSync(dir)) walk(dir, 0);
  return fonts;
}

// =============================================
// Flutter
// =============================================

function detectFlutterFonts(rootDir: string): string[] {
  const fonts: string[] = [];

  // 1. pubspec.yaml fonts section
  const pubspecPath = join(rootDir, "pubspec.yaml");
  const pubspecContent = readFileSafe(pubspecPath);
  if (pubspecContent) {
    try {
      const doc = yaml.parse(pubspecContent);
      const flutterFonts = doc?.flutter?.fonts;
      if (Array.isArray(flutterFonts)) {
        for (const entry of flutterFonts) {
          if (entry.family && typeof entry.family === "string") {
            fonts.push(entry.family);
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Scan .dart files for fontFamily and GoogleFonts
  const dartFiles = findFiles(rootDir, [".dart"], 6);
  for (const file of dartFiles.slice(0, 80)) {
    const content = readFileSafe(file);
    if (!content) continue;

    // fontFamily: 'Name' or fontFamily: "Name"
    const fontFamilyMatches = content.matchAll(/fontFamily\s*:\s*['"]([^'"]+)['"]/g);
    for (const match of fontFamilyMatches) {
      fonts.push(match[1]);
    }

    // GoogleFonts.poppins() pattern
    const googleFontsMatches = content.matchAll(/GoogleFonts\.(\w+)\s*\(/g);
    for (const match of googleFontsMatches) {
      if (match[1] !== "getFont" && match[1] !== "getTextTheme") {
        fonts.push(camelToTitleCase(match[1]));
      }
    }

    // GoogleFonts.getFont('Name')
    const getFontMatches = content.matchAll(/GoogleFonts\.getFont\s*\(\s*['"]([^'"]+)['"]/g);
    for (const match of getFontMatches) {
      fonts.push(match[1]);
    }
  }

  return fonts;
}

// =============================================
// React Native / Capacitor
// =============================================

function detectJSFonts(rootDir: string): string[] {
  const fonts: string[] = [];

  // 1. Scan JS/TS/TSX files for fontFamily
  const jsFiles = findFiles(rootDir, [".ts", ".tsx", ".js", ".jsx"], 5);
  for (const file of jsFiles.slice(0, 100)) {
    const content = readFileSafe(file);
    if (!content) continue;

    const matches = content.matchAll(/fontFamily\s*:\s*['"]([^'"]+)['"]/g);
    for (const match of matches) {
      fonts.push(match[1]);
    }
  }

  // 2. Scan font asset directories
  const fontDirs = [
    join(rootDir, "assets/fonts"),
    join(rootDir, "src/assets/fonts"),
    join(rootDir, "app/assets/fonts"),
  ];

  for (const dir of fontDirs) {
    const fontFiles = scanForFontFiles(dir, 1);
    for (const f of fontFiles) {
      fonts.push(fontNameFromFile(f));
    }
  }

  return fonts;
}

// =============================================
// Swift
// =============================================

function detectSwiftFonts(rootDir: string): string[] {
  const fonts: string[] = [];

  // 1. Scan .swift files for UIFont and Font.custom
  const swiftFiles = findFiles(rootDir, [".swift"], 6);
  for (const file of swiftFiles.slice(0, 80)) {
    const content = readFileSafe(file);
    if (!content) continue;

    // UIFont(name: "FontName", size: ...)
    const uiFontMatches = content.matchAll(/UIFont\s*\(\s*name:\s*"([^"]+)"/g);
    for (const match of uiFontMatches) {
      fonts.push(match[1]);
    }

    // Font.custom("FontName", ...) or .font(.custom("FontName", ...))
    const customFontMatches = content.matchAll(/\.?custom\s*\(\s*"([^"]+)"/g);
    for (const match of customFontMatches) {
      fonts.push(match[1]);
    }
  }

  // 2. Parse Info.plist for UIAppFonts
  const plistPaths = [
    join(rootDir, "Info.plist"),
    ...findPlistFiles(rootDir),
  ];

  for (const plistPath of plistPaths) {
    const content = readFileSafe(plistPath);
    if (!content) continue;
    try {
      const data = plist.parse(content) as Record<string, unknown>;
      const appFonts = data.UIAppFonts;
      if (Array.isArray(appFonts)) {
        for (const fontFile of appFonts) {
          if (typeof fontFile === "string") {
            fonts.push(fontNameFromFile(fontFile));
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Scan for font files in the project
  const fontDirs = [
    join(rootDir, "Fonts"),
    join(rootDir, "Resources/Fonts"),
  ];

  // Also search xcassets/fonts-like directories
  for (const dir of fontDirs) {
    const fontFiles = scanForFontFiles(dir, 2);
    for (const f of fontFiles) {
      fonts.push(fontNameFromFile(f));
    }
  }

  return fonts;
}

function findPlistFiles(rootDir: string): string[] {
  const results: string[] = [];

  function search(dir: string, depth: number) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "Pods" || entry === "DerivedData" || entry === "build") continue;
        const fullPath = join(dir, entry);
        if (entry === "Info.plist") {
          results.push(fullPath);
          continue;
        }
        try {
          if (statSync(fullPath).isDirectory()) {
            search(fullPath, depth + 1);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  search(rootDir, 0);
  return results;
}

// =============================================
// Android / Kotlin
// =============================================

function detectAndroidFonts(rootDir: string): string[] {
  const fonts: string[] = [];

  // 1. Scan res/font/ directories
  const resFontDirs = [
    join(rootDir, "app/src/main/res/font"),
    join(rootDir, "src/main/res/font"),
  ];

  for (const dir of resFontDirs) {
    const fontFiles = scanForFontFiles(dir, 1);
    for (const f of fontFiles) {
      // Android font files use underscores: poppins_regular.ttf → Poppins
      fonts.push(fontNameFromFile(f));
    }
  }

  // 2. Scan XML files for android:fontFamily
  const xmlFiles = findFiles(rootDir, [".xml"], 5);
  for (const file of xmlFiles.slice(0, 50)) {
    const content = readFileSafe(file);
    if (!content) continue;

    const matches = content.matchAll(/android:fontFamily\s*=\s*"(?:@font\/)?([^"]+)"/g);
    for (const match of matches) {
      const name = match[1];
      // Convert underscore name to proper name
      fonts.push(name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
    }
  }

  // 3. Scan Kotlin files for Compose Font(R.font.name)
  const ktFiles = findFiles(rootDir, [".kt"], 6);
  for (const file of ktFiles.slice(0, 80)) {
    const content = readFileSafe(file);
    if (!content) continue;

    const fontResMatches = content.matchAll(/Font\s*\(\s*R\.font\.(\w+)/g);
    for (const match of fontResMatches) {
      fonts.push(match[1].replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
    }

    // fontFamily in Compose: fontFamily = FontFamily(...)
    const fontFamilyMatches = content.matchAll(/fontFamily\s*=\s*FontFamily\s*\(/g);
    // These usually reference R.font resources, already caught above
    void fontFamilyMatches;
  }

  return fonts;
}

// =============================================
// Main Export
// =============================================

export function detectFonts(rootDir: string, techStack: TechStack): string[] {
  let rawFonts: string[];

  switch (techStack) {
    case "flutter":
      rawFonts = detectFlutterFonts(rootDir);
      break;
    case "react-native":
    case "capacitor":
      rawFonts = detectJSFonts(rootDir);
      break;
    case "swift":
      rawFonts = detectSwiftFonts(rootDir);
      break;
    case "kotlin":
    case "java":
      rawFonts = detectAndroidFonts(rootDir);
      break;
    default:
      rawFonts = [];
  }

  // Clean, deduplicate, filter system fonts
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawFonts) {
    const cleaned = cleanFontName(raw);
    if (!cleaned || cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    if (SYSTEM_FONTS.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }

  // Sort alphabetically and cap at 5
  return result.sort().slice(0, 5);
}
