import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname, relative, basename } from "path";
import type { TechStack, CLIAppAsset, CLIAssetType } from "../types/report.js";

const MAX_ASSET_SIZE = 5 * 1024 * 1024; // 5MB per asset (screenshots can be large)
const MAX_TOTAL_ASSETS = 10;
const MAX_SCREENSHOTS = 5;
const MIN_ASSET_SIZE = 500; // Skip tiny placeholders
const MIN_SCREENSHOT_SIZE = 10_000; // 10KB — screenshots from general dirs must be substantial
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function tryReadImage(
  rootDir: string,
  filePath: string,
  assetType: CLIAssetType,
  minSize = MIN_ASSET_SIZE
): CLIAppAsset | null {
  try {
    if (!existsSync(filePath)) return null;

    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size < minSize) return null; // Too small, likely placeholder or icon
    if (stat.size > MAX_ASSET_SIZE) return null;

    const buffer = readFileSync(filePath);
    return {
      asset_type: assetType,
      file_name: basename(filePath),
      mime_type: getMimeType(filePath),
      base64_data: buffer.toString("base64"),
      width: null,
      height: null,
      source_path: relative(rootDir, filePath),
    };
  } catch {
    return null;
  }
}

function collectImagesFromDir(
  rootDir: string,
  dirPath: string,
  assetType: CLIAssetType,
  assets: CLIAppAsset[],
  maxCount: number,
  minSize = MIN_ASSET_SIZE
): void {
  if (!existsSync(dirPath)) return;

  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }

  try {
    const entries = readdirSync(dirPath)
      .filter((e) => isImageFile(e))
      .sort(); // Alphabetical for consistent ordering

    for (const entry of entries) {
      if (assets.filter((a) => a.asset_type === assetType).length >= maxCount) break;
      if (assets.length >= MAX_TOTAL_ASSETS) break;

      const asset = tryReadImage(rootDir, join(dirPath, entry), assetType, minSize);
      if (asset) assets.push(asset);
    }
  } catch {
    // Directory read failed
  }
}

function collectImagesRecursive(
  rootDir: string,
  dirPath: string,
  assetType: CLIAssetType,
  assets: CLIAppAsset[],
  maxCount: number,
  maxDepth = 3,
  currentDepth = 0,
  minSize = MIN_ASSET_SIZE
): void {
  if (currentDepth > maxDepth) return;
  if (!existsSync(dirPath)) return;

  try {
    const entries = readdirSync(dirPath);

    // First collect images in this directory
    for (const entry of entries) {
      if (assets.filter((a) => a.asset_type === assetType).length >= maxCount) return;
      if (assets.length >= MAX_TOTAL_ASSETS) return;

      const fullPath = join(dirPath, entry);
      if (isImageFile(entry)) {
        const asset = tryReadImage(rootDir, fullPath, assetType, minSize);
        if (asset) assets.push(asset);
      }
    }

    // Then recurse into subdirectories
    for (const entry of entries) {
      if (assets.filter((a) => a.asset_type === assetType).length >= maxCount) return;

      const fullPath = join(dirPath, entry);
      try {
        if (statSync(fullPath).isDirectory() && !entry.startsWith(".")) {
          collectImagesRecursive(rootDir, fullPath, assetType, assets, maxCount, maxDepth, currentDepth + 1, minSize);
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Directory read failed
  }
}

// =============================================
// Screenshot Paths
// =============================================

interface ScreenshotDir {
  path: string;
  minSize: number; // General dirs use higher threshold to skip tiny icons
}

function getScreenshotDirs(rootDir: string, techStack: TechStack): ScreenshotDir[] {
  const dirs: ScreenshotDir[] = [];
  const ss = (p: string) => ({ path: p, minSize: MIN_ASSET_SIZE }); // dedicated screenshot dir
  const gen = (p: string) => ({ path: p, minSize: MIN_SCREENSHOT_SIZE }); // general asset dir

  // Common locations across all tech stacks
  dirs.push(
    ss(join(rootDir, "screenshots")),
    ss(join(rootDir, "Screenshots")),
    ss(join(rootDir, "assets/screenshots")),
    ss(join(rootDir, "assets/images/screenshots")),
  );

  // Fastlane (common for iOS and Android)
  dirs.push(
    ss(join(rootDir, "fastlane/screenshots")),
    ss(join(rootDir, "fastlane/metadata/en-US/images/phoneScreenshots")),
    ss(join(rootDir, "fastlane/metadata/en-US/images/tabletScreenshots")),
  );

  switch (techStack) {
    case "flutter":
      dirs.push(
        ss(join(rootDir, "assets/screenshots")),
        ss(join(rootDir, "metadata/screenshots")),
        // General Flutter asset directories — use higher threshold
        gen(join(rootDir, "assets/images")),
        gen(join(rootDir, "assets/img")),
        gen(join(rootDir, "assets")),
      );
      break;

    case "react-native":
    case "capacitor":
      dirs.push(
        ss(join(rootDir, "src/assets/screenshots")),
        gen(join(rootDir, "src/assets/images")),
        gen(join(rootDir, "src/assets")),
        ss(join(rootDir, "docs/screenshots")),
        gen(join(rootDir, "assets/images")),
        gen(join(rootDir, "assets")),
      );
      break;

    case "swift":
      dirs.push(
        ss(join(rootDir, "fastlane/screenshots/en-US")),
        ss(join(rootDir, "fastlane/metadata/en-US/images/phoneScreenshots")),
        gen(join(rootDir, "marketing")),
        gen(join(rootDir, "Marketing")),
      );
      break;

    case "kotlin":
    case "java":
      dirs.push(
        ss(join(rootDir, "fastlane/metadata/android/en-US/images/phoneScreenshots")),
        gen(join(rootDir, "metadata/android/en-US/images")),
        gen(join(rootDir, "marketing")),
        gen(join(rootDir, "Marketing")),
      );
      break;
  }

  return dirs;
}

// =============================================
// Splash Screen Paths
// =============================================

function getSplashPaths(rootDir: string, techStack: TechStack): string[] {
  const paths: string[] = [];

  switch (techStack) {
    case "flutter":
      paths.push(
        join(rootDir, "assets/splash.png"),
        join(rootDir, "assets/images/splash.png"),
        join(rootDir, "assets/splash/splash.png"),
        join(rootDir, "assets/images/splash_screen.png"),
        // flutter_native_splash output paths
        join(rootDir, "android/app/src/main/res/drawable-xxhdpi/android12splash.png"),
        join(rootDir, "android/app/src/main/res/drawable-xxxhdpi/android12splash.png"),
        join(rootDir, "ios/Runner/Assets.xcassets/LaunchImage.imageset/LaunchImage.png"),
        join(rootDir, "ios/Runner/Assets.xcassets/LaunchImage.imageset/LaunchImage@2x.png"),
        join(rootDir, "ios/Runner/Assets.xcassets/LaunchImage.imageset/LaunchImage@3x.png"),
      );
      // Also check Android drawable for splash
      for (const density of ["xxxhdpi", "xxhdpi", "xhdpi"]) {
        paths.push(
          join(rootDir, `android/app/src/main/res/drawable-${density}/splash.png`),
          join(rootDir, `android/app/src/main/res/drawable-${density}/launch_screen.png`),
        );
      }
      break;

    case "react-native":
    case "capacitor":
      paths.push(
        join(rootDir, "assets/splash.png"),
        join(rootDir, "src/assets/splash.png"),
        join(rootDir, "assets/images/splash.png"),
        join(rootDir, "resources/splash.png"),
      );
      break;

    case "kotlin":
    case "java":
      // Check drawable directories for splash images
      for (const density of ["xxxhdpi", "xxhdpi", "xhdpi"]) {
        paths.push(
          join(rootDir, `app/src/main/res/drawable-${density}/splash.png`),
          join(rootDir, `app/src/main/res/drawable-${density}/launch_screen.png`),
        );
      }
      break;
  }

  return paths;
}

// =============================================
// Feature Graphic Paths
// =============================================

function getFeatureGraphicPaths(rootDir: string, techStack: TechStack): string[] {
  const paths: string[] = [];

  // Fastlane Android feature graphic
  paths.push(
    join(rootDir, "fastlane/metadata/android/en-US/images/featureGraphic.png"),
    join(rootDir, "fastlane/metadata/android/en-US/images/featureGraphic.jpg"),
    join(rootDir, "metadata/android/en-US/images/featureGraphic.png"),
  );

  switch (techStack) {
    case "flutter":
    case "react-native":
    case "capacitor":
      paths.push(
        join(rootDir, "assets/feature_graphic.png"),
        join(rootDir, "assets/feature-graphic.png"),
      );
      break;

    case "kotlin":
    case "java":
      paths.push(
        join(rootDir, "app/src/main/feature_graphic.png"),
      );
      break;
  }

  return paths;
}

// =============================================
// Promotional Image Paths
// =============================================

function getPromotionalPaths(rootDir: string, techStack: TechStack): string[] {
  const paths: string[] = [];

  paths.push(
    join(rootDir, "fastlane/metadata/android/en-US/images/promoGraphic.png"),
    join(rootDir, "fastlane/metadata/android/en-US/images/promoGraphic.jpg"),
    join(rootDir, "assets/promo.png"),
    join(rootDir, "assets/promotional.png"),
  );

  if (techStack === "swift") {
    paths.push(
      join(rootDir, "fastlane/metadata/en-US/promotional.png"),
    );
  }

  return paths;
}

// =============================================
// Main Scanner
// =============================================

/**
 * Scan the project for visual assets: screenshots, splash screens,
 * feature graphics, and promotional images.
 * Note: App icon is handled separately by branding.ts
 */
export function scanAppAssets(
  rootDir: string,
  techStack: TechStack
): CLIAppAsset[] {
  const assets: CLIAppAsset[] = [];

  // 1. Scan for screenshots (most common and most useful for landing pages)
  const screenshotDirs = getScreenshotDirs(rootDir, techStack);
  for (const { path: dir, minSize } of screenshotDirs) {
    if (assets.filter((a) => a.asset_type === "screenshot").length >= MAX_SCREENSHOTS) break;
    if (assets.length >= MAX_TOTAL_ASSETS) break;
    collectImagesRecursive(rootDir, dir, "screenshot", assets, MAX_SCREENSHOTS, 3, 0, minSize);
  }

  // 2. Scan for splash screens
  const splashPaths = getSplashPaths(rootDir, techStack);
  for (const path of splashPaths) {
    if (assets.length >= MAX_TOTAL_ASSETS) break;
    if (assets.some((a) => a.asset_type === "splash_screen")) break;
    const asset = tryReadImage(rootDir, path, "splash_screen");
    if (asset) {
      assets.push(asset);
      break; // Only need one splash screen
    }
  }

  // 3. Scan for feature graphics
  const featurePaths = getFeatureGraphicPaths(rootDir, techStack);
  for (const path of featurePaths) {
    if (assets.length >= MAX_TOTAL_ASSETS) break;
    if (assets.some((a) => a.asset_type === "feature_graphic")) break;
    const asset = tryReadImage(rootDir, path, "feature_graphic");
    if (asset) {
      assets.push(asset);
      break;
    }
  }

  // 4. Scan for promotional images
  const promoPaths = getPromotionalPaths(rootDir, techStack);
  for (const path of promoPaths) {
    if (assets.length >= MAX_TOTAL_ASSETS) break;
    if (assets.some((a) => a.asset_type === "promotional_image")) break;
    const asset = tryReadImage(rootDir, path, "promotional_image");
    if (asset) {
      assets.push(asset);
      break;
    }
  }

  return assets.slice(0, MAX_TOTAL_ASSETS);
}
