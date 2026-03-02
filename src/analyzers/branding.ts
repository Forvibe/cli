import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import type { TechStack, BrandingResult } from "../types/report.js";
import { readFileSafe, findFiles } from "../utils/file-scanner.js";

/**
 * Extract branding information (colors and app icon) from the project
 */
export function extractBranding(
  rootDir: string,
  techStack: TechStack
): BrandingResult {
  const result: BrandingResult = {
    primary_color: null,
    secondary_color: null,
    app_icon_base64: null,
    app_icon_path: null,
  };

  // Extract colors
  const colors = extractColors(rootDir, techStack);
  result.primary_color = colors.primary;
  result.secondary_color = colors.secondary;

  // Find and encode app icon
  const icon = findAppIcon(rootDir, techStack);
  result.app_icon_base64 = icon.base64;
  result.app_icon_path = icon.path;

  return result;
}

// =============================================
// Color Extraction
// =============================================

function extractColors(
  rootDir: string,
  techStack: TechStack
): { primary: string | null; secondary: string | null } {
  switch (techStack) {
    case "flutter":
      return extractFlutterColors(rootDir);
    case "react-native":
    case "capacitor":
      return extractJSColors(rootDir);
    case "swift":
      return extractSwiftColors(rootDir);
    case "kotlin":
    case "java":
      return extractAndroidColors(rootDir);
    default:
      return { primary: null, secondary: null };
  }
}

function extractFlutterColors(rootDir: string): {
  primary: string | null;
  secondary: string | null;
} {
  // Search in lib/ for Color patterns
  const dartFiles = findFiles(rootDir, [".dart"], 6);
  const hexColors: string[] = [];

  for (const file of dartFiles.slice(0, 50)) {
    const content = readFileSafe(file);
    if (!content) continue;

    // Color(0xFF123456) pattern
    const colorMatches = content.matchAll(/Color\(0[xX]([0-9a-fA-F]{8})\)/g);
    for (const match of colorMatches) {
      const hex = match[1].substring(2); // Remove alpha
      hexColors.push(`#${hex}`);
    }

    // Color.fromARGB / fromRGBO patterns
    const argbMatches = content.matchAll(
      /Color\.fromARGB\(\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g
    );
    for (const match of argbMatches) {
      const r = parseInt(match[1]).toString(16).padStart(2, "0");
      const g = parseInt(match[2]).toString(16).padStart(2, "0");
      const b = parseInt(match[3]).toString(16).padStart(2, "0");
      hexColors.push(`#${r}${g}${b}`);
    }

    // primarySwatch or primaryColor assignments
    const primaryMatch = content.match(
      /primary(?:Swatch|Color)\s*:\s*(?:Colors\.(\w+)|Color\(0[xX]([0-9a-fA-F]{8})\))/
    );
    if (primaryMatch) {
      if (primaryMatch[2]) {
        return {
          primary: `#${primaryMatch[2].substring(2)}`,
          secondary: hexColors.length > 1 ? hexColors[1] : null,
        };
      }
    }
  }

  return {
    primary: hexColors.length > 0 ? hexColors[0] : null,
    secondary: hexColors.length > 1 ? hexColors[1] : null,
  };
}

function extractJSColors(rootDir: string): {
  primary: string | null;
  secondary: string | null;
} {
  // Look for theme/colors files
  const themeFileNames = [
    "theme.ts",
    "theme.js",
    "colors.ts",
    "colors.js",
    "theme.tsx",
    "constants.ts",
    "Colors.ts",
    "Colors.js",
  ];

  const hexColors: string[] = [];

  for (const fileName of themeFileNames) {
    const files = findFiles(rootDir, [], 5).filter((f) =>
      f.endsWith(fileName)
    );
    for (const file of files) {
      const content = readFileSafe(file);
      if (!content) continue;

      // #RRGGBB pattern
      const matches = content.matchAll(
        /['"]#([0-9a-fA-F]{6})['"]/g
      );
      for (const match of matches) {
        hexColors.push(`#${match[1]}`);
      }

      // primary key
      const primaryMatch = content.match(
        /primary\s*[:=]\s*['"]#([0-9a-fA-F]{6})['"]/
      );
      if (primaryMatch) {
        const secondaryMatch = content.match(
          /secondary\s*[:=]\s*['"]#([0-9a-fA-F]{6})['"]/
        );
        return {
          primary: `#${primaryMatch[1]}`,
          secondary: secondaryMatch ? `#${secondaryMatch[1]}` : null,
        };
      }
    }
  }

  return {
    primary: hexColors.length > 0 ? hexColors[0] : null,
    secondary: hexColors.length > 1 ? hexColors[1] : null,
  };
}

function extractSwiftColors(rootDir: string): {
  primary: string | null;
  secondary: string | null;
} {
  const hexColors: string[] = [];

  // 1. First check Assets.xcassets for AccentColor (most reliable for SwiftUI)
  const assetsCatalogs = findAssetsCatalogs(rootDir);
  for (const catalog of assetsCatalogs) {
    const accentColor = parseColorSetInCatalog(catalog, "AccentColor");
    if (accentColor) {
      hexColors.push(accentColor);
      break;
    }
  }

  // 2. Scan all colorsets in Assets.xcassets for named colors
  for (const catalog of assetsCatalogs) {
    try {
      const entries = readdirSync(catalog);
      for (const entry of entries) {
        if (entry.endsWith(".colorset") && entry !== "AccentColor.colorset") {
          const color = parseColorSet(join(catalog, entry));
          if (color) hexColors.push(color);
        }
      }
    } catch { /* ignore */ }
    if (hexColors.length >= 2) break;
  }

  // 3. Scan Swift source files for hex color patterns
  const swiftFiles = findFiles(rootDir, [".swift"], 6);
  for (const file of swiftFiles.slice(0, 50)) {
    const content = readFileSafe(file);
    if (!content) continue;

    // UIColor(hex: 0x...) or Color(hex: "...")
    const hexMatches = content.matchAll(
      /(?:UIColor|Color)\s*\(\s*(?:hex|hexString)\s*:\s*(?:0[xX]|"#?)([0-9a-fA-F]{6})/g
    );
    for (const match of hexMatches) {
      hexColors.push(`#${match[1]}`);
    }

    // Color literal with red/green/blue
    const colorLiteral = content.matchAll(
      /#colorLiteral\s*\(\s*red:\s*([0-9.]+)\s*,\s*green:\s*([0-9.]+)\s*,\s*blue:\s*([0-9.]+)/g
    );
    for (const match of colorLiteral) {
      const r = Math.round(parseFloat(match[1]) * 255).toString(16).padStart(2, "0");
      const g = Math.round(parseFloat(match[2]) * 255).toString(16).padStart(2, "0");
      const b = Math.round(parseFloat(match[3]) * 255).toString(16).padStart(2, "0");
      hexColors.push(`#${r}${g}${b}`);
    }

    // Color("SomeName") — look up in assets
    const namedColorMatches = content.matchAll(/Color\s*\(\s*"([^"]+)"\s*\)/g);
    for (const match of namedColorMatches) {
      for (const catalog of assetsCatalogs) {
        const color = parseColorSetInCatalog(catalog, match[1]);
        if (color) {
          hexColors.push(color);
          break;
        }
      }
    }
  }

  return {
    primary: hexColors.length > 0 ? hexColors[0] : null,
    secondary: hexColors.length > 1 ? hexColors[1] : null,
  };
}

function extractAndroidColors(rootDir: string): {
  primary: string | null;
  secondary: string | null;
} {
  const hexColors: string[] = [];

  // Check colors.xml and themes.xml
  const colorFiles = ["colors.xml", "themes.xml", "styles.xml"];
  for (const fileName of colorFiles) {
    // Search in res/values directories
    for (const resDir of ["app/src/main/res/values", "src/main/res/values"]) {
      const filePath = join(rootDir, resDir, fileName);
      const content = readFileSafe(filePath);
      if (!content) continue;

      // Extract named colors: <color name="primary">#FF6200EE</color>
      const colorMatches = content.matchAll(
        /<color\s+name="([^"]*)">\s*#([0-9a-fA-F]{6,8})\s*<\/color>/g
      );
      for (const match of colorMatches) {
        const name = match[1].toLowerCase();
        let hex = match[2];
        // If ARGB (8 chars), strip alpha prefix
        if (hex.length === 8) hex = hex.substring(2);
        const color = `#${hex}`;

        if (name.includes("primary") && !name.includes("variant") && !name.includes("dark")) {
          hexColors.unshift(color); // prioritize primary
        } else if (name.includes("secondary") || name.includes("accent")) {
          hexColors.push(color);
        } else {
          hexColors.push(color);
        }
      }

      // Jetpack Compose: colorScheme primary/secondary from theme items
      const themeColorMatches = content.matchAll(
        /<item\s+name="(?:color|android:color)([^"]*)">\s*@color\/([^<]+)\s*<\/item>/g
      );
      for (const match of themeColorMatches) {
        if (match[1].toLowerCase().includes("primary")) {
          // Reference to another color — we already parsed those above
        }
      }
    }
  }

  // Jetpack Compose: Check Kotlin theme files for Color() declarations
  const ktFiles = findFiles(rootDir, [".kt"], 6);
  for (const file of ktFiles.slice(0, 50)) {
    const fileName = file.toLowerCase();
    if (!fileName.includes("color") && !fileName.includes("theme")) continue;

    const content = readFileSafe(file);
    if (!content) continue;

    // Color(0xFF6200EE) pattern
    const colorMatches = content.matchAll(/Color\s*\(\s*0[xX]([0-9a-fA-F]{8})\s*\)/g);
    for (const match of colorMatches) {
      hexColors.push(`#${match[1].substring(2)}`); // Strip alpha
    }
  }

  return {
    primary: hexColors.length > 0 ? hexColors[0] : null,
    secondary: hexColors.length > 1 ? hexColors[1] : null,
  };
}

/**
 * Find all Assets.xcassets directories in the project (recursive)
 */
function findAssetsCatalogs(rootDir: string): string[] {
  const catalogs: string[] = [];

  function search(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "Pods" || entry === "DerivedData") continue;
        const fullPath = join(dir, entry);
        if (entry === "Assets.xcassets") {
          catalogs.push(fullPath);
          continue; // Don't recurse into xcassets
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
  return catalogs;
}

/**
 * Parse a specific color name from an Assets.xcassets catalog
 */
function parseColorSetInCatalog(catalogPath: string, colorName: string): string | null {
  return parseColorSet(join(catalogPath, `${colorName}.colorset`));
}

/**
 * Parse a .colorset directory's Contents.json to extract the hex color
 */
function parseColorSet(colorSetPath: string): string | null {
  const contentsPath = join(colorSetPath, "Contents.json");
  const content = readFileSafe(contentsPath);
  if (!content) return null;

  try {
    const data = JSON.parse(content);
    // Prefer universal (light) appearance
    const colors = data.colors as Array<{
      color?: { components?: Record<string, string>; "color-space"?: string };
      idiom?: string;
      appearances?: unknown[];
    }>;
    if (!colors?.length) return null;

    // Use the first entry without appearances (universal/light mode)
    const universalEntry = colors.find((c) => !c.appearances) || colors[0];
    const components = universalEntry?.color?.components;
    if (!components) return null;

    // Components can be either 0-1 float or 0-255 int or hex string
    const parseComponent = (val: string): number => {
      if (val.startsWith("0x") || val.startsWith("0X")) {
        return parseInt(val, 16);
      }
      const num = parseFloat(val);
      // If <= 1.0, it's a 0-1 float (unless it's exactly 0 or 1)
      return num > 1 ? Math.round(num) : Math.round(num * 255);
    };

    const r = parseComponent(components.red).toString(16).padStart(2, "0");
    const g = parseComponent(components.green).toString(16).padStart(2, "0");
    const b = parseComponent(components.blue).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  } catch { /* ignore */ }

  return null;
}

// =============================================
// App Icon Extraction
// =============================================

function findAppIcon(
  rootDir: string,
  techStack: TechStack
): { base64: string | null; path: string | null } {
  const iconPaths: string[] = [];

  switch (techStack) {
    case "flutter":
      iconPaths.push(
        // Flutter launcher icons plugin
        join(rootDir, "assets/icon/icon.png"),
        join(rootDir, "assets/icon.png"),
        join(rootDir, "assets/images/icon.png"),
        join(rootDir, "assets/launcher_icon.png"),
        // iOS
        ...findIconsInAppIconSet(join(rootDir, "ios/Runner/Assets.xcassets/AppIcon.appiconset")),
        // Android
        join(rootDir, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"),
        join(rootDir, "android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png"),
      );
      break;

    case "react-native":
    case "capacitor":
      iconPaths.push(
        join(rootDir, "assets/icon.png"),
        join(rootDir, "src/assets/icon.png"),
        join(rootDir, "assets/images/icon.png"),
        ...findIconsInAppIconSet(join(rootDir, "ios")),
        join(rootDir, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"),
      );
      break;

    case "swift":
      iconPaths.push(
        ...findIconsInAppIconSet(rootDir),
      );
      break;

    case "kotlin":
    case "java":
      iconPaths.push(
        join(rootDir, "app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"),
        join(rootDir, "app/src/main/res/mipmap-xxhdpi/ic_launcher.png"),
        join(rootDir, "app/src/main/res/mipmap-xhdpi/ic_launcher.png"),
        join(rootDir, "app/src/main/ic_launcher-playstore.png"),
      );
      break;
  }

  // Try each path
  for (const iconPath of iconPaths) {
    if (existsSync(iconPath)) {
      try {
        const stat = statSync(iconPath);
        // Skip icons larger than 5MB
        if (stat.size > 5 * 1024 * 1024) continue;
        // Skip very small icons (likely placeholders)
        if (stat.size < 100) continue;

        const buffer = readFileSync(iconPath);
        const ext = extname(iconPath).toLowerCase();
        const mime =
          ext === ".png"
            ? "image/png"
            : ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : "image/png";
        const base64 = `data:${mime};base64,${buffer.toString("base64")}`;
        return { base64, path: iconPath };
      } catch {
        continue;
      }
    }
  }

  return { base64: null, path: null };
}

function findIconsInAppIconSet(searchDir: string): string[] {
  const icons: string[] = [];

  function searchRecursive(dir: string, depth: number) {
    if (depth > 6) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        if (entry === "AppIcon.appiconset") {
          // Read Contents.json to find the largest icon
          const contentsPath = join(fullPath, "Contents.json");
          const content = readFileSafe(contentsPath);
          if (content) {
            try {
              const data = JSON.parse(content);
              const images = data.images as Array<{
                filename?: string;
                size?: string;
                scale?: string;
              }>;
              // Find largest icon
              const sorted = images
                .filter((img) => img.filename)
                .sort((a, b) => {
                  const sizeA = parseInt(a.size?.split("x")[0] || "0") * parseInt(a.scale?.replace("x", "") || "1");
                  const sizeB = parseInt(b.size?.split("x")[0] || "0") * parseInt(b.scale?.replace("x", "") || "1");
                  return sizeB - sizeA;
                });
              for (const img of sorted) {
                if (img.filename) {
                  icons.push(join(fullPath, img.filename));
                }
              }
            } catch { /* ignore */ }
          }
          // Also add any png files in the directory
          try {
            const iconEntries = readdirSync(fullPath);
            for (const ie of iconEntries) {
              if (ie.endsWith(".png")) {
                icons.push(join(fullPath, ie));
              }
            }
          } catch { /* ignore */ }
          return;
        }

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            searchRecursive(fullPath, depth + 1);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  if (existsSync(searchDir)) {
    searchRecursive(searchDir, 0);
  }

  return icons;
}
