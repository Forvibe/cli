import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import type { TechStack, BrandingResult } from "../types/report.js";
import { readFileSafe, findFiles, findAllFiles } from "../utils/file-scanner.js";

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
    brand_colors: [],
  };

  // Extract colors
  const colors = extractColors(rootDir, techStack);
  result.primary_color = colors.primary;
  result.secondary_color = colors.secondary;
  result.brand_colors = extractBrandColors(colors.allColors);

  // Find and encode app icon
  const icon = findAppIcon(rootDir, techStack);
  result.app_icon_base64 = icon.base64;
  result.app_icon_path = icon.path;

  return result;
}

// =============================================
// Color Extraction
// =============================================

type ColorResult = { primary: string | null; secondary: string | null; allColors: string[] };

function extractColors(
  rootDir: string,
  techStack: TechStack
): ColorResult {
  switch (techStack) {
    case "flutter":
      return extractFlutterColors(rootDir);
    case "expo":
      return extractExpoColors(rootDir);
    case "react-native":
    case "capacitor":
      return extractJSColors(rootDir);
    case "swift":
      return extractSwiftColors(rootDir);
    case "kotlin":
      return extractAndroidColors(rootDir);
    case "dotnet-maui":
      return extractMauiColors(rootDir);
    default:
      return { primary: null, secondary: null, allColors: [] };
  }
}

function extractExpoColors(rootDir: string): ColorResult {
  const hexColors: string[] = [];
  let primary: string | null = null;
  let secondary: string | null = null;

  const HEX = /^#[0-9a-fA-F]{6}$/;
  const normalize = (raw: string): string | null => {
    if (!raw) return null;
    const v = raw.trim();
    if (HEX.test(v)) return v.toLowerCase();
    if (/^#[0-9a-fA-F]{8}$/.test(v)) return `#${v.slice(3).toLowerCase()}`; // strip alpha
    return null;
  };

  // 1. app.json expo block
  const appJsonContent = readFileSafe(join(rootDir, "app.json"));
  if (appJsonContent) {
    try {
      const data = JSON.parse(appJsonContent);
      const expo = data.expo || data;
      const candidates: Array<string | undefined> = [
        expo.primaryColor,
        expo.splash?.backgroundColor,
        expo.android?.adaptiveIcon?.backgroundColor,
        expo.android?.splash?.backgroundColor,
        expo.ios?.splash?.backgroundColor,
      ];
      for (const c of candidates) {
        const n = normalize(c || "");
        if (n) hexColors.push(n);
      }
      primary = normalize(expo.primaryColor || "") || null;
    } catch { /* ignore */ }
  }

  // 2. JS theme/colors fallback
  const jsResult = extractJSColors(rootDir);
  if (!primary) primary = jsResult.primary;
  if (!secondary) secondary = jsResult.secondary;
  hexColors.push(...jsResult.allColors);

  return {
    primary: primary || (hexColors[0] ?? null),
    secondary: secondary || (hexColors[1] ?? null),
    allColors: hexColors,
  };
}

function extractMauiColors(rootDir: string): ColorResult {
  const hexColors: string[] = [];

  // 1. Resources/Styles/Colors.xaml — definitive design system source
  const xamlPaths = [
    join(rootDir, "Resources/Styles/Colors.xaml"),
    join(rootDir, "Resources/Styles/Styles.xaml"),
  ];
  // Also locate via deep find (in case nested project structure)
  const allXaml = findFiles(rootDir, [".xaml"], 5);
  for (const p of allXaml) {
    if (/Colors\.xaml$/i.test(p) && !xamlPaths.includes(p)) xamlPaths.push(p);
  }

  for (const path of xamlPaths) {
    const content = readFileSafe(path);
    if (!content) continue;
    const colorMatches = content.matchAll(
      /<Color\s+x:Key="([^"]+)"\s*>\s*#([0-9a-fA-F]{6,8})\s*<\/Color>/g
    );
    for (const match of colorMatches) {
      const name = match[1].toLowerCase();
      let hex = match[2];
      if (hex.length === 8) hex = hex.substring(2); // strip alpha
      const color = `#${hex.toLowerCase()}`;
      if (name.includes("primary") && !name.includes("dark") && !name.includes("light")) {
        hexColors.unshift(color);
      } else {
        hexColors.push(color);
      }
    }
    // Also <SolidColorBrush x:Key="..." Color="#RRGGBB" />
    const brushMatches = content.matchAll(
      /<SolidColorBrush\s+[^>]*Color\s*=\s*"#([0-9a-fA-F]{6,8})"/g
    );
    for (const match of brushMatches) {
      let hex = match[1];
      if (hex.length === 8) hex = hex.substring(2);
      hexColors.push(`#${hex.toLowerCase()}`);
    }
  }

  // 2. C# source: Color.FromArgb("#RRGGBB") or Color.FromRgb(r,g,b)
  const csFiles = findFiles(rootDir, [".cs"], 5);
  for (const file of csFiles.slice(0, 50)) {
    const content = readFileSafe(file);
    if (!content) continue;
    const argbMatches = content.matchAll(
      /Color\.FromArgb\s*\(\s*"#?([0-9a-fA-F]{6,8})"/g
    );
    for (const match of argbMatches) {
      let hex = match[1];
      if (hex.length === 8) hex = hex.substring(2);
      hexColors.push(`#${hex.toLowerCase()}`);
    }
    const rgbMatches = content.matchAll(
      /Color\.FromRgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g
    );
    for (const match of rgbMatches) {
      const r = parseInt(match[1]).toString(16).padStart(2, "0");
      const g = parseInt(match[2]).toString(16).padStart(2, "0");
      const b = parseInt(match[3]).toString(16).padStart(2, "0");
      hexColors.push(`#${r}${g}${b}`);
    }
  }

  return {
    primary: hexColors[0] ?? null,
    secondary: hexColors[1] ?? null,
    allColors: hexColors,
  };
}

function isIrrelevantColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Perceived brightness (0-255)
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  if (brightness > 242 || brightness < 13) return true;
  // Grayscale check (R ≈ G ≈ B)
  const maxDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
  if (maxDiff < 15) return true;
  return false;
}

function extractBrandColors(allColors: string[]): string[] {
  const freq = new Map<string, number>();
  for (const raw of allColors) {
    const hex = raw.toLowerCase().slice(0, 7); // normalize to #rrggbb
    if (hex.length !== 7 || !hex.startsWith("#")) continue;
    freq.set(hex, (freq.get(hex) || 0) + 1);
  }

  // Filter irrelevant and sort by frequency
  const filtered = [...freq.entries()]
    .filter(([hex]) => !isIrrelevantColor(hex))
    .sort((a, b) => b[1] - a[1]);

  return filtered.slice(0, 3).map(([hex]) => hex);
}

function extractFlutterColors(rootDir: string): ColorResult {
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
          allColors: hexColors,
        };
      }
    }
  }

  return {
    primary: hexColors.length > 0 ? hexColors[0] : null,
    secondary: hexColors.length > 1 ? hexColors[1] : null,
    allColors: hexColors,
  };
}

function extractJSColors(rootDir: string): ColorResult {
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
          allColors: hexColors,
        };
      }
    }
  }

  return {
    primary: hexColors.length > 0 ? hexColors[0] : null,
    secondary: hexColors.length > 1 ? hexColors[1] : null,
    allColors: hexColors,
  };
}

function extractSwiftColors(rootDir: string): ColorResult {
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
    allColors: hexColors,
  };
}

function extractAndroidColors(rootDir: string): ColorResult {
  const hexColors: string[] = [];
  let primary: string | null = null;
  let secondary: string | null = null;

  const normalize = (hexDigits: string): string => {
    // Accepts RRGGBB or AARRGGBB, strips alpha.
    const h = hexDigits.length === 8 ? hexDigits.slice(2) : hexDigits;
    return `#${h.toLowerCase()}`;
  };

  // 1. Build color_name → hex map from every colors.xml in the project
  //    (multi-module: e.g. design-system/src/main/res/values/colors.xml).
  const colorMap = new Map<string, string>();
  const colorsFiles = findAllFiles(rootDir, "colors.xml", 8);
  for (const path of colorsFiles) {
    const content = readFileSafe(path);
    if (!content) continue;
    const matches = content.matchAll(
      /<color\s+name="([^"]+)"[^>]*>\s*#([0-9a-fA-F]{6,8})\s*<\/color>/g
    );
    for (const m of matches) {
      const hex = normalize(m[2]);
      colorMap.set(m[1], hex);
      hexColors.push(hex);

      const name = m[1].toLowerCase();
      if (
        name.includes("primary") &&
        !name.includes("variant") &&
        !name.includes("dark") &&
        !name.includes("container") &&
        !primary
      ) {
        primary = hex;
      } else if ((name.includes("secondary") || name.includes("accent")) && !secondary) {
        secondary = hex;
      }
    }
  }

  // 2. Resolve <item name="colorPrimary">@color/…</item> refs in themes/styles.
  //    This is how Material theme overrides declare primary/secondary colors.
  const themeFiles = [
    ...findAllFiles(rootDir, "themes.xml", 8),
    ...findAllFiles(rootDir, "styles.xml", 8),
  ];
  for (const path of themeFiles) {
    const content = readFileSafe(path);
    if (!content) continue;
    const itemMatches = content.matchAll(
      /<item\s+name="(?:android:)?([A-Za-z]+)"[^>]*>\s*(?:@color\/([A-Za-z0-9_]+)|#([0-9a-fA-F]{6,8}))\s*<\/item>/g
    );
    for (const m of itemMatches) {
      const itemName = m[1].toLowerCase();
      if (!itemName.startsWith("color")) continue;
      let hex: string | null = null;
      if (m[2]) hex = colorMap.get(m[2]) || null;
      else if (m[3]) hex = normalize(m[3]);
      if (!hex) continue;

      if (itemName === "colorprimary" || itemName === "colorprimarydark") {
        if (!primary) primary = hex;
      } else if (
        itemName === "colorsecondary" ||
        itemName === "colortertiary" ||
        itemName === "coloraccent"
      ) {
        if (!secondary) secondary = hex;
      }
      hexColors.push(hex);
    }
  }

  // 3. Jetpack Compose: scan *.kt theme/color files.
  //    Builds a `val Foo = Color(0xFFxxxxxx)` symbol table, then resolves
  //    refs inside `lightColorScheme(primary = Foo, secondary = Bar, ...)`.
  const ktFiles = findFiles(rootDir, [".kt"], 6);
  for (const file of ktFiles.slice(0, 80)) {
    const fileName = file.toLowerCase();
    if (!fileName.includes("color") && !fileName.includes("theme")) continue;

    const content = readFileSafe(file);
    if (!content) continue;

    const valMap = new Map<string, string>();
    const valMatches = content.matchAll(
      /val\s+(\w+)\s*(?::\s*Color\s*)?=\s*Color\s*\(\s*0[xX]([0-9a-fA-F]{8})\s*\)/g
    );
    for (const m of valMatches) {
      const hex = normalize(m[2]);
      valMap.set(m[1], hex);
      hexColors.push(hex);
    }

    // Plain Color(0xFF…) literals anywhere in the file
    const literalMatches = content.matchAll(/Color\s*\(\s*0[xX]([0-9a-fA-F]{8})\s*\)/g);
    for (const m of literalMatches) {
      hexColors.push(normalize(m[1]));
    }

    // lightColorScheme/darkColorScheme primary/secondary resolution
    const schemeMatch = content.match(
      /(?:light|dark)ColorScheme\s*\(\s*([\s\S]*?)\n\s*\)/
    );
    if (schemeMatch) {
      const body = schemeMatch[1];
      const resolve = (key: string): string | null => {
        const re = new RegExp(
          `\\b${key}\\s*=\\s*(?:Color\\s*\\(\\s*0[xX]([0-9a-fA-F]{8})\\s*\\)|(\\w+))`
        );
        const m = body.match(re);
        if (!m) return null;
        if (m[1]) return normalize(m[1]);
        return valMap.get(m[2]) || null;
      };
      if (!primary) {
        const p = resolve("primary");
        if (p) primary = p;
      }
      if (!secondary) {
        const s = resolve("secondary") || resolve("tertiary");
        if (s) secondary = s;
      }
    }
  }

  return {
    primary: primary || hexColors[0] || null,
    secondary: secondary || hexColors[1] || null,
    allColors: hexColors,
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

    case "expo":
      iconPaths.push(
        // Resolve from app.json expo block first
        ...resolveExpoIconPaths(rootDir),
        // Common Expo defaults
        join(rootDir, "assets/icon.png"),
        join(rootDir, "assets/adaptive-icon.png"),
        join(rootDir, "assets/images/icon.png"),
        join(rootDir, "assets/images/adaptive-icon.png"),
        // Bare workflow fallback
        ...findIconsInAppIconSet(join(rootDir, "ios")),
        join(rootDir, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"),
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

    case "kotlin": {
      // Common module names — Android projects don't always use "app" as the
      // application module name (e.g. :mobile, :androidApp, :presentation).
      const modules = ["app", "mobile", "androidApp", "presentation", ""];
      const densities = ["xxxhdpi", "xxhdpi", "xhdpi"];

      // Priority 1: Play Store icon (512×512 — highest quality, perfect for landing pages)
      for (const mod of modules) {
        const prefix = mod ? `${mod}/` : "";
        iconPaths.push(
          join(rootDir, `${prefix}src/main/ic_launcher-playstore.png`),
          join(rootDir, `${prefix}ic_launcher-playstore.png`),
        );
      }

      // Priority 2: Adaptive icon foreground (API 26+ — modern Android apps)
      for (const mod of modules) {
        const prefix = mod ? `${mod}/` : "";
        for (const d of densities) {
          iconPaths.push(
            join(rootDir, `${prefix}src/main/res/mipmap-${d}/ic_launcher_foreground.png`),
            join(rootDir, `${prefix}src/main/res/mipmap-${d}/ic_launcher_foreground.webp`),
          );
        }
      }

      // Priority 3: Legacy launcher icons (.png / .webp / round variant)
      for (const mod of modules) {
        const prefix = mod ? `${mod}/` : "";
        for (const d of densities) {
          iconPaths.push(
            join(rootDir, `${prefix}src/main/res/mipmap-${d}/ic_launcher.png`),
            join(rootDir, `${prefix}src/main/res/mipmap-${d}/ic_launcher.webp`),
            join(rootDir, `${prefix}src/main/res/mipmap-${d}/ic_launcher_round.png`),
            join(rootDir, `${prefix}src/main/res/mipmap-${d}/ic_launcher_round.webp`),
          );
        }
      }
      break;
    }

    case "dotnet-maui":
      iconPaths.push(
        join(rootDir, "Resources/AppIcon/appicon.png"),
        join(rootDir, "Resources/AppIcon/appiconfg.png"),
        join(rootDir, "Resources/Images/icon.png"),
        join(rootDir, "Resources/Images/appicon.png"),
        // SVG fallback (MAUI default is SVG appicon.svg)
        join(rootDir, "Resources/AppIcon/appicon.svg"),
        join(rootDir, "Resources/AppIcon/appiconfg.svg"),
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
              : ext === ".svg"
                ? "image/svg+xml"
                : ext === ".webp"
                  ? "image/webp"
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

function resolveExpoIconPaths(rootDir: string): string[] {
  const paths: string[] = [];
  const appJsonContent = readFileSafe(join(rootDir, "app.json"));
  if (!appJsonContent) return paths;
  try {
    const data = JSON.parse(appJsonContent);
    const expo = data.expo || data;
    const candidates = [
      expo.icon,
      expo.android?.icon,
      expo.android?.adaptiveIcon?.foregroundImage,
      expo.ios?.icon,
    ].filter((v) => typeof v === "string");
    for (const rel of candidates) {
      const cleaned = rel.replace(/^\.?\//, "");
      paths.push(join(rootDir, cleaned));
    }
  } catch { /* ignore */ }
  return paths;
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
