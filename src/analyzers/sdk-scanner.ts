import { join } from "path";
import { readdirSync } from "fs";
import YAML from "yaml";
import type {
  DataCollectedType,
  AdvertisingType,
  ThirdPartyServices,
  DetectedSDK,
  SDKScanResult,
  TechStack,
} from "../types/report.js";
import { readFileSafe, findFile, findFiles } from "../utils/file-scanner.js";
import type { EcosystemDeps } from "../engine/types.js";

interface SDKMapping {
  category: keyof ThirdPartyServices;
  collects: DataCollectedType[];
  advertising?: AdvertisingType;
}

// Known SDK → privacy mapping
const SDK_MAP: Record<string, SDKMapping> = {
  // Analytics
  firebase_analytics: { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "firebase-analytics": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  firebase_core: { category: "analytics", collects: ["device_info"] },
  "firebase-core": { category: "analytics", collects: ["device_info"] },
  amplitude_flutter: { category: "analytics", collects: ["usage_analytics"] },
  amplitude: { category: "analytics", collects: ["usage_analytics"] },
  "@amplitude/analytics-react-native": { category: "analytics", collects: ["usage_analytics"] },
  mixpanel_flutter: { category: "analytics", collects: ["usage_analytics"] },
  mixpanel: { category: "analytics", collects: ["usage_analytics"] },
  "@mixpanel/mixpanel-react-native": { category: "analytics", collects: ["usage_analytics"] },
  posthog_flutter: { category: "analytics", collects: ["usage_analytics"] },
  "posthog-react-native": { category: "analytics", collects: ["usage_analytics"] },
  sentry_flutter: { category: "analytics", collects: ["device_info"] },
  "@sentry/react-native": { category: "analytics", collects: ["device_info"] },
  appsflyer_sdk: { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "react-native-appsflyer": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  adjust_sdk: { category: "analytics", collects: ["usage_analytics", "device_info"] },

  // Auth
  firebase_auth: { category: "auth", collects: ["name_email"] },
  "firebase-auth": { category: "auth", collects: ["name_email"] },
  google_sign_in: { category: "auth", collects: ["name_email", "profile_photo"] },
  "@react-native-google-signin/google-signin": { category: "auth", collects: ["name_email", "profile_photo"] },
  sign_in_with_apple: { category: "auth", collects: ["name_email"] },
  "@invertase/react-native-apple-authentication": { category: "auth", collects: ["name_email"] },
  flutter_facebook_auth: { category: "auth", collects: ["name_email", "profile_photo"] },
  supabase_flutter: { category: "auth", collects: ["name_email"] },
  "@supabase/supabase-js": { category: "auth", collects: ["name_email"] },
  appwrite: { category: "auth", collects: ["name_email"] },

  // Ads
  google_mobile_ads: { category: "ads", collects: ["device_info"], advertising: "personalized" },
  "react-native-google-mobile-ads": { category: "ads", collects: ["device_info"], advertising: "personalized" },
  facebook_audience_network: { category: "ads", collects: ["device_info"], advertising: "personalized" },
  unity_ads: { category: "ads", collects: ["device_info"], advertising: "personalized" },
  applovin_max: { category: "ads", collects: ["device_info"], advertising: "personalized" },
  ironsource: { category: "ads", collects: ["device_info"], advertising: "personalized" },

  // Payment
  in_app_purchase: { category: "payment", collects: ["financial_info"] },
  in_app_purchase_storekit: { category: "payment", collects: ["financial_info"] },
  "react-native-iap": { category: "payment", collects: ["financial_info"] },
  purchases_flutter: { category: "payment", collects: ["financial_info"] },
  "react-native-purchases": { category: "payment", collects: ["financial_info"] },
  stripe_flutter: { category: "payment", collects: ["financial_info"] },
  "@stripe/stripe-react-native": { category: "payment", collects: ["financial_info"] },

  // Cloud
  cloud_firestore: { category: "cloud", collects: [] },
  firebase_storage: { category: "cloud", collects: [] },
  firebase_database: { category: "cloud", collects: [] },
  aws_amplify: { category: "cloud", collects: [] },

  // Location
  geolocator: { category: "other", collects: ["location"] },
  location: { category: "other", collects: ["location"] },
  "react-native-geolocation-service": { category: "other", collects: ["location"] },
  "@react-native-community/geolocation": { category: "other", collects: ["location"] },
  google_maps_flutter: { category: "other", collects: ["location"] },
  "react-native-maps": { category: "other", collects: ["location"] },

  // Health
  health: { category: "other", collects: ["health_data"] },
  "react-native-health": { category: "other", collects: ["health_data"] },

  // Camera / Photos
  image_picker: { category: "other", collects: ["photos_media"] },
  camera: { category: "other", collects: ["photos_media"] },
  "react-native-image-picker": { category: "other", collects: ["photos_media"] },
  "react-native-camera": { category: "other", collects: ["photos_media"] },

  // Contacts
  contacts_service: { category: "other", collects: ["contacts"] },
  "react-native-contacts": { category: "other", collects: ["contacts"] },

  // AI
  google_generative_ai: { category: "ai", collects: [] },
  openai: { category: "ai", collects: [] },
  langchain: { category: "ai", collects: [] },

  // Social
  share_plus: { category: "social", collects: [] },
  "react-native-share": { category: "social", collects: [] },

  // --- Native iOS frameworks (detected via `import` in Swift source) ---
  HealthKit: { category: "other", collects: ["health_data"] },
  StoreKit: { category: "payment", collects: ["financial_info"] },
  MapKit: { category: "other", collects: ["location"] },
  CoreLocation: { category: "other", collects: ["location"] },
  PhotosUI: { category: "other", collects: ["photos_media"] },
  AVFoundation: { category: "other", collects: ["photos_media"] },
  Contacts: { category: "other", collects: ["contacts"] },
  ContactsUI: { category: "other", collects: ["contacts"] },
  AuthenticationServices: { category: "auth", collects: ["name_email"] },
  AdSupport: { category: "ads", collects: ["device_info"], advertising: "personalized" },
  AppTrackingTransparency: { category: "ads", collects: ["device_info"], advertising: "personalized" },
  GameKit: { category: "other", collects: [] },
  WebKit: { category: "other", collects: [] },
  CoreBluetooth: { category: "other", collects: [] },
  CoreMotion: { category: "other", collects: [] },
  LocalAuthentication: { category: "auth", collects: ["biometric_data"] },
  UserNotifications: { category: "other", collects: [] },
  CloudKit: { category: "cloud", collects: [] },
  CoreData: { category: "cloud", collects: [] },
  CoreML: { category: "ai", collects: [] },
  Vision: { category: "ai", collects: [] },
  NaturalLanguage: { category: "ai", collects: [] },
  SpriteKit: { category: "other", collects: [] },
  SceneKit: { category: "other", collects: [] },
  ARKit: { category: "other", collects: [] },
  RealityKit: { category: "other", collects: [] },
  EventKit: { category: "other", collects: [] },

  // --- Expo SDK packages ---
  "expo-notifications": { category: "other", collects: ["device_info"] },
  "expo-tracking-transparency": { category: "ads", collects: ["device_info"], advertising: "personalized" },
  "expo-location": { category: "other", collects: ["location"] },
  "expo-contacts": { category: "other", collects: ["contacts"] },
  "expo-camera": { category: "other", collects: ["photos_media"] },
  "expo-image-picker": { category: "other", collects: ["photos_media"] },
  "expo-media-library": { category: "other", collects: ["photos_media"] },
  "expo-auth-session": { category: "auth", collects: ["name_email"] },
  "expo-apple-authentication": { category: "auth", collects: ["name_email"] },
  "expo-google-sign-in": { category: "auth", collects: ["name_email", "profile_photo"] },
  "expo-in-app-purchases": { category: "payment", collects: ["financial_info"] },
  "expo-ads-admob": { category: "ads", collects: ["device_info"], advertising: "personalized" },
  "expo-firebase-analytics": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "expo-local-authentication": { category: "auth", collects: ["biometric_data"] },
  "expo-health-connect": { category: "other", collects: ["health_data"] },
  "expo-sensors": { category: "other", collects: ["device_info"] },
  "expo-device": { category: "other", collects: ["device_info"] },

  // --- .NET MAUI packages ---
  "Microsoft.AppCenter.Analytics": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "Microsoft.AppCenter.Crashes": { category: "analytics", collects: ["device_info"] },
  "Sentry.Maui": { category: "analytics", collects: ["device_info"] },
  "Plugin.Firebase": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "Plugin.Firebase.Analytics": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "Plugin.Firebase.Auth": { category: "auth", collects: ["name_email"] },
  "Plugin.Firebase.CloudMessaging": { category: "other", collects: ["device_info"] },
  "Plugin.GoogleClient": { category: "auth", collects: ["name_email", "profile_photo"] },
  "Plugin.SignInWithApple": { category: "auth", collects: ["name_email"] },
  "Plugin.InAppBilling": { category: "payment", collects: ["financial_info"] },
  "CommunityToolkit.Maui": { category: "other", collects: [] },
  "CommunityToolkit.Maui.MediaElement": { category: "other", collects: ["photos_media"] },
  "Plugin.Maui.Audio": { category: "other", collects: ["photos_media"] },
  "Xamarin.Google.Android.Play.Review": { category: "other", collects: [] },
  "Plugin.LocalNotification": { category: "other", collects: [] },
  "Plugin.Maui.Biometric": { category: "auth", collects: ["biometric_data"] },
  "Plugin.Permissions": { category: "other", collects: [] },
  "Mapsui.Maui": { category: "other", collects: ["location"] },
  "Plugin.Maui.AppRating": { category: "other", collects: [] },
  "Plugin.Geolocator": { category: "other", collects: ["location"] },

  // --- Native Android frameworks (detected via `import` in Kotlin/Java source) ---
  "com.google.android.gms.ads": { category: "ads", collects: ["device_info"], advertising: "personalized" },
  "com.google.android.gms.maps": { category: "other", collects: ["location"] },
  "com.google.android.gms.location": { category: "other", collects: ["location"] },
  "com.google.android.gms.auth": { category: "auth", collects: ["name_email", "profile_photo"] },
  "com.android.billingclient": { category: "payment", collects: ["financial_info"] },
  "androidx.health": { category: "other", collects: ["health_data"] },
  "androidx.biometric": { category: "auth", collects: ["biometric_data"] },
  "androidx.camera": { category: "other", collects: ["photos_media"] },
  "androidx.compose": { category: "other", collects: [] },
  "androidx.navigation.compose": { category: "other", collects: [] },

  // --- Android artifact-name keys (unique enough that bare artifact name is safe) ---
  "play-services-ads": { category: "ads", collects: ["device_info"], advertising: "personalized" },
  "play-services-ads-lite": { category: "ads", collects: ["device_info"], advertising: "personalized" },
  "play-services-maps": { category: "other", collects: ["location"] },
  "play-services-location": { category: "other", collects: ["location"] },
  "play-services-auth": { category: "auth", collects: ["name_email", "profile_photo"] },
  "play-services-auth-api-phone": { category: "auth", collects: ["name_email"] },
  billing: { category: "payment", collects: ["financial_info"] },
  "billing-ktx": { category: "payment", collects: ["financial_info"] },
  biometric: { category: "auth", collects: ["biometric_data"] },
  "biometric-ktx": { category: "auth", collects: ["biometric_data"] },
  "health-connect-client": { category: "other", collects: ["health_data"] },
  "camera-core": { category: "other", collects: ["photos_media"] },
  "camera-camera2": { category: "other", collects: ["photos_media"] },
  "camera-lifecycle": { category: "other", collects: ["photos_media"] },
  "camera-view": { category: "other", collects: ["photos_media"] },
  "camera-extensions": { category: "other", collects: ["photos_media"] },
  // firebase-analytics / firebase-auth already declared above (Flutter dep names)
  "firebase-analytics-ktx": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "firebase-auth-ktx": { category: "auth", collects: ["name_email"] },
  "firebase-crashlytics": { category: "analytics", collects: ["device_info"] },
  "firebase-crashlytics-ktx": { category: "analytics", collects: ["device_info"] },
  "firebase-messaging": { category: "other", collects: ["device_info"] },
  "firebase-messaging-ktx": { category: "other", collects: ["device_info"] },
  "firebase-firestore": { category: "cloud", collects: [] },
  "firebase-firestore-ktx": { category: "cloud", collects: [] },
  "firebase-storage": { category: "cloud", collects: [] },
  "firebase-storage-ktx": { category: "cloud", collects: [] },
  "firebase-database": { category: "cloud", collects: [] },
  "firebase-database-ktx": { category: "cloud", collects: [] },
  "firebase-config": { category: "cloud", collects: [] },
  "firebase-config-ktx": { category: "cloud", collects: [] },
  "firebase-functions": { category: "cloud", collects: [] },
  "firebase-functions-ktx": { category: "cloud", collects: [] },
  "hilt-android": { category: "other", collects: [] },
  "hilt-navigation-compose": { category: "other", collects: [] },
  "koin-android": { category: "other", collects: [] },
  "koin-androidx-compose": { category: "other", collects: [] },
  "room-runtime": { category: "other", collects: [] },
  "room-ktx": { category: "other", collects: [] },
  "room-compiler": { category: "other", collects: [] },
  retrofit: { category: "other", collects: [] },
  "retrofit-converter-gson": { category: "other", collects: [] },
  "retrofit-converter-moshi": { category: "other", collects: [] },
  okhttp: { category: "other", collects: [] },
  "okhttp-logging-interceptor": { category: "other", collects: [] },
  "coil-compose": { category: "other", collects: [] },
  coil: { category: "other", collects: [] },
  glide: { category: "other", collects: [] },
  "navigation-compose": { category: "other", collects: [] },
  "activity-compose": { category: "other", collects: [] },
  "lifecycle-viewmodel-compose": { category: "other", collects: [] },
  "lifecycle-runtime-compose": { category: "other", collects: [] },
  "work-runtime": { category: "other", collects: [] },
  "work-runtime-ktx": { category: "other", collects: [] },
  "datastore-preferences": { category: "other", collects: [] },
  "kotlinx-coroutines-android": { category: "other", collects: [] },

  // --- group:artifact keys for Compose (artifact names alone are ambiguous: "ui", "material3") ---
  "androidx.compose.ui:ui": { category: "other", collects: [] },
  "androidx.compose.ui:ui-tooling": { category: "other", collects: [] },
  "androidx.compose.ui:ui-tooling-preview": { category: "other", collects: [] },
  "androidx.compose.material3:material3": { category: "other", collects: [] },
  "androidx.compose.material:material": { category: "other", collects: [] },
  "androidx.compose.material:material-icons-extended": { category: "other", collects: [] },
  "androidx.compose.foundation:foundation": { category: "other", collects: [] },
  "androidx.compose.runtime:runtime": { category: "other", collects: [] },
  "androidx.compose.animation:animation": { category: "other", collects: [] },

  // --- Popular third-party Android SDKs (group:artifact keys) ---
  "com.revenuecat.purchases:purchases": { category: "payment", collects: ["financial_info"] },
  "com.adjust.sdk:adjust-android": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "com.appsflyer:af-android-sdk": { category: "analytics", collects: ["usage_analytics", "device_info"] },
  "io.sentry:sentry-android": { category: "analytics", collects: ["device_info"] },
  "com.amplitude:android-sdk": { category: "analytics", collects: ["usage_analytics"] },
  "com.mixpanel.android:mixpanel-android": { category: "analytics", collects: ["usage_analytics"] },
  "com.posthog:posthog-android": { category: "analytics", collects: ["usage_analytics"] },
  "com.stripe:stripe-android": { category: "payment", collects: ["financial_info"] },
};

/**
 * Parse the [libraries] section of a Gradle Version Catalog (libs.versions.toml).
 * Fills `catalog` with `alias → "group:artifact"` entries, supporting:
 *   - shorthand:    alias = "group:artifact:version"
 *   - inline table: alias = { module = "group:artifact", version.ref = "…" }
 *   - inline table: alias = { group = "…", name = "…", version = "…" }
 */
function parseVersionCatalog(content: string, catalog: Map<string, string>): void {
  const idx = content.indexOf("[libraries]");
  if (idx < 0) return;
  const after = content.slice(idx + "[libraries]".length);
  const nextSection = after.search(/\n\s*\[[^\]]+\]/);
  const block = nextSection >= 0 ? after.slice(0, nextSection) : after;

  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const alias = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!alias) continue;

    // Shorthand: "group:artifact[:version]"
    const shorthand = value.match(/^"([^"]+)"$/);
    if (shorthand) {
      const parts = shorthand[1].split(":");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        catalog.set(alias, `${parts[0]}:${parts[1]}`);
      }
      continue;
    }

    // Inline table — try `module = "group:artifact"` first
    const moduleMatch = value.match(/module\s*=\s*"([^"]+)"/);
    if (moduleMatch) {
      const parts = moduleMatch[1].split(":");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        catalog.set(alias, `${parts[0]}:${parts[1]}`);
      }
      continue;
    }

    // Fallback: `group = "…", name = "…"`
    const groupMatch = value.match(/group\s*=\s*"([^"]+)"/);
    const nameMatch = value.match(/name\s*=\s*"([^"]+)"/);
    if (groupMatch && nameMatch) {
      catalog.set(alias, `${groupMatch[1]}:${nameMatch[1]}`);
    }
  }
}

/**
 * Scan project dependencies for known SDKs
 */
export function scanSDKs(
  rootDir: string,
  techStack: TechStack
): SDKScanResult {
  const detectedSDKs: DetectedSDK[] = [];
  const dataCollected = new Set<DataCollectedType>();
  let advertisingType: AdvertisingType = "none";
  const thirdPartyServices: ThirdPartyServices = {
    analytics: [],
    payment: [],
    auth: [],
    ads: [],
    cloud: [],
    ai: [],
    social: [],
    other: [],
  };
  let hasIAP = false;

  const dependencies = getDependencies(rootDir, techStack);

  for (const dep of dependencies) {
    const normalizedDep = dep.toLowerCase().replace(/-/g, "_");

    // Check both original and normalized name
    const mapping = SDK_MAP[dep] || SDK_MAP[normalizedDep];
    if (mapping) {
      detectedSDKs.push({
        name: dep,
        category: mapping.category,
        collects: mapping.collects,
      });

      for (const collected of mapping.collects) {
        dataCollected.add(collected);
      }

      if (mapping.advertising && mapping.advertising !== "none") {
        advertisingType = mapping.advertising;
      }

      // Add to third-party services
      if (!thirdPartyServices[mapping.category].includes(dep)) {
        thirdPartyServices[mapping.category].push(dep);
      }

      // Check for IAP
      if (mapping.category === "payment") {
        hasIAP = true;
      }
    }
  }

  return {
    detected_sdks: detectedSDKs,
    data_collected: Array.from(dataCollected),
    advertising_type: advertisingType,
    third_party_services: thirdPartyServices,
    has_iap: hasIAP,
  };
}

/**
 * Get all dependency names from the project
 */
function getDependencies(rootDir: string, techStack: TechStack): string[] {
  const deps: string[] = [];

  switch (techStack) {
    case "flutter": {
      const pubspecContent = readFileSafe(join(rootDir, "pubspec.yaml"));
      if (pubspecContent) {
        try {
          const pubspec = YAML.parse(pubspecContent);
          if (pubspec.dependencies) {
            deps.push(...Object.keys(pubspec.dependencies));
          }
          if (pubspec.dev_dependencies) {
            deps.push(...Object.keys(pubspec.dev_dependencies));
          }
        } catch { /* ignore */ }
      }
      break;
    }

    case "expo":
    case "react-native":
    case "capacitor": {
      const pkgContent = readFileSafe(join(rootDir, "package.json"));
      if (pkgContent) {
        try {
          const pkg = JSON.parse(pkgContent);
          if (pkg.dependencies) deps.push(...Object.keys(pkg.dependencies));
          if (pkg.devDependencies) deps.push(...Object.keys(pkg.devDependencies));
        } catch { /* ignore */ }
      }
      break;
    }

    case "dotnet-maui": {
      // Find all .csproj files at root and one level deep
      const csprojFiles: string[] = [];
      try {
        for (const entry of readdirSync(rootDir)) {
          if (entry.endsWith(".csproj")) csprojFiles.push(join(rootDir, entry));
        }
      } catch { /* ignore */ }
      // Also nested csproj (e.g. src/MyApp/MyApp.csproj)
      const nested = findFiles(rootDir, [".csproj"], 3);
      for (const f of nested) {
        if (!csprojFiles.includes(f)) csprojFiles.push(f);
      }

      for (const path of csprojFiles) {
        const content = readFileSafe(path);
        if (!content) continue;
        const pkgMatches = content.matchAll(
          /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/g
        );
        for (const match of pkgMatches) {
          if (!deps.includes(match[1])) deps.push(match[1]);
        }
      }
      break;
    }

    case "swift": {
      // Podfile
      const podfileContent = readFileSafe(join(rootDir, "Podfile"));
      if (podfileContent) {
        const podMatches = podfileContent.matchAll(/pod\s+['"]([^'"]+)['"]/g);
        for (const match of podMatches) {
          deps.push(match[1]);
        }
      }
      // Package.swift (standalone)
      const packageSwift = readFileSafe(join(rootDir, "Package.swift"));
      if (packageSwift) {
        const urlMatches = packageSwift.matchAll(
          /\.package\([^)]*url:\s*"[^"]*\/([^/"]+?)(?:\.git)?"/g
        );
        for (const match of urlMatches) {
          deps.push(match[1]);
        }
      }
      // SPM packages embedded in .xcodeproj (XCRemoteSwiftPackageReference)
      const pbxprojPath = findFile(rootDir, "project.pbxproj", 5);
      if (pbxprojPath) {
        const pbxContent = readFileSafe(pbxprojPath);
        if (pbxContent) {
          // Extract SPM package names from repositoryURL
          const spmMatches = pbxContent.matchAll(
            /repositoryURL\s*=\s*"[^"]*\/([^/"]+?)(?:\.git)?"/g
          );
          for (const match of spmMatches) {
            if (!deps.includes(match[1])) {
              deps.push(match[1]);
            }
          }
        }
      }
      // Native framework imports from Swift source files
      const swiftFiles = findFiles(rootDir, [".swift"], 6);
      const nativeImports = new Set<string>();
      for (const file of swiftFiles.slice(0, 100)) {
        const content = readFileSafe(file);
        if (!content) continue;
        const importMatches = content.matchAll(/^import\s+(\w+)/gm);
        for (const match of importMatches) {
          const framework = match[1];
          // Only add if it's a known native framework in SDK_MAP
          if (SDK_MAP[framework] && !nativeImports.has(framework)) {
            nativeImports.add(framework);
          }
        }
      }
      deps.push(...nativeImports);
      break;
    }

    case "kotlin": {
      // 1. Parse Gradle Version Catalog (libs.versions.toml) — modern Compose projects
      //    use `implementation(libs.androidx.compose.ui)` instead of string coords.
      const catalog = new Map<string, string>(); // alias → "group:artifact"
      for (const p of [
        join(rootDir, "gradle/libs.versions.toml"),
        join(rootDir, "libs.versions.toml"),
      ]) {
        const content = readFileSafe(p);
        if (content) parseVersionCatalog(content, catalog);
      }

      // 2. Collect all build.gradle[.kts] files — supports multi-module projects
      //    (feature modules, core modules, etc. — not just app/).
      const gradleFiles = new Set<string>([
        join(rootDir, "app/build.gradle"),
        join(rootDir, "app/build.gradle.kts"),
        join(rootDir, "build.gradle"),
        join(rootDir, "build.gradle.kts"),
      ]);
      for (const f of findFiles(rootDir, ["build.gradle", "build.gradle.kts"], 5)) {
        gradleFiles.add(f);
      }

      const addCoord = (coord: string) => {
        const parts = coord.split(":");
        if (parts.length < 2) return;
        const [group, artifact] = parts;
        if (!group || !artifact) return;
        // Keep both forms so SDK_MAP can match either artifact-only or fully-qualified keys.
        if (!deps.includes(artifact)) deps.push(artifact);
        const gav = `${group}:${artifact}`;
        if (!deps.includes(gav)) deps.push(gav);
      };

      // Dependency coordinate pattern: matches "group:artifact" or "group:artifact:version"
      // inside any string literal — robust to multi-line function calls and platform(...)/
      // enforcedPlatform(...) BOM wrappers.
      const coordRegex =
        /['"]([a-zA-Z][\w.-]*\.[a-zA-Z][\w.-]*:[a-zA-Z][\w.-]*(?::[^'"\s]+)?)['"]/g;
      // Version catalog reference: libs.foo.bar → alias "foo-bar"
      const libsRefRegex = /\blibs\.([a-zA-Z][\w.]*)/g;

      for (const path of gradleFiles) {
        const content = readFileSafe(path);
        if (!content) continue;

        for (const m of content.matchAll(coordRegex)) {
          addCoord(m[1]);
        }
        for (const m of content.matchAll(libsRefRegex)) {
          const ref = m[1];
          const resolved =
            catalog.get(ref) || catalog.get(ref.replace(/\./g, "-"));
          if (resolved) addCoord(resolved);
        }
      }

      // 3. Native Android framework imports from Kotlin/Java sources
      //    (covers multi-module layouts: scan all module src/ dirs, not just app/src/)
      const androidFiles = [
        ...findFiles(join(rootDir, "app/src"), [".kt", ".java"], 8),
        ...findFiles(rootDir, [".kt", ".java"], 6),
      ];
      const androidNativeImports = new Set<string>();
      const androidFrameworkPrefixes = [
        "com.google.android.gms.ads",
        "com.google.android.gms.maps",
        "com.google.android.gms.location",
        "com.google.android.gms.auth",
        "com.android.billingclient",
        "androidx.health",
        "androidx.biometric",
        "androidx.camera",
        "androidx.compose",
        "androidx.navigation.compose",
      ];
      const seen = new Set<string>();
      for (const file of androidFiles) {
        if (seen.has(file)) continue;
        seen.add(file);
        if (seen.size > 200) break;
        const content = readFileSafe(file);
        if (!content) continue;
        for (const prefix of androidFrameworkPrefixes) {
          if (content.includes(`import ${prefix}`) && !androidNativeImports.has(prefix)) {
            androidNativeImports.add(prefix);
          }
        }
      }
      deps.push(...androidNativeImports);
      break;
    }
  }

  return deps;
}

// =============================================================================
// Raw dependency collection (review-engine v2 / Task 3b) - ADDITIVE.
//
// Everything below is new. scanSDKs()/getDependencies() above are UNTOUCHED -
// the `analyze` command depends on their exact current behavior (locked in by
// test/analyzers/sdk-scanner-compat.test.ts). This section builds a separate,
// UNFILTERED ("raw") view of a project's dependencies for the new
// registry-driven SDK matcher (src/engine/registry.ts) to consume, replacing
// the SDK_MAP allowlist approach above for the review-engine's purposes.
//
// Where reuse is safe and side-effect-free, existing helpers are called
// directly (parseVersionCatalog). The gradle-coordinate extraction is a
// fresh, lightly duplicated implementation (see collectGradleCoordinates)
// rather than a shared refactor of the legacy scan, because it needs one
// deliberate behavioral difference: `classpath` (buildscript/plugin-tooling)
// declarations are excluded, since those are build tooling, not shipped app
// SDKs. The legacy scan above doesn't care about this distinction because its
// output is filtered again downstream through SDK_MAP; this collector's
// output is consumed directly by the registry matcher with no such net (see
// collectGradleCoordinates for the concrete case this matters for: a bare
// Flutter/Android project's own `android/build.gradle` buildscript block
// would otherwise leak a "com.android.tools.build:gradle" non-SDK coordinate
// into the raw dependency set).
//
// Similarly, the native-import scanners below (collectSwiftImports,
// collectAndroidImports) are NOT gated by SDK_MAP or the small curated
// android-framework-prefix allowlist the legacy scan uses - they return every
// import found, unfiltered. The registry matcher needs to see imports this
// file's hardcoded lists don't know about (e.g. "UIKit", which isn't an
// SDK_MAP key at all).
// =============================================================================

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Candidate gradle build files under `baseDir` - a project root for the
 * "kotlin" stack, or the nested "android/" directory for flutter /
 * react-native / expo / capacitor stacks. Mirrors the file-discovery shape of
 * the legacy kotlin-case scan above (app module first, then the project
 * root, then a depth-5 recursive sweep for multi-module layouts).
 */
function gradleCandidateFiles(baseDir: string): string[] {
  const candidates = new Set<string>([
    join(baseDir, "app/build.gradle"),
    join(baseDir, "app/build.gradle.kts"),
    join(baseDir, "build.gradle"),
    join(baseDir, "build.gradle.kts"),
  ]);
  for (const f of findFiles(baseDir, ["build.gradle", "build.gradle.kts"], 5)) {
    candidates.add(f);
  }
  return Array.from(candidates);
}

/**
 * Extracts Gradle dependency coordinates in canonical "group:artifact" form
 * (ONE entry per dependency - unlike the legacy addCoord above, this does
 * NOT also push the bare artifact name; see the note below for why) from
 * `gradleFiles`. Reuses parseVersionCatalog() as-is for libs.versions.toml
 * resolution (`androidRoot` locates the catalog file:
 * "<androidRoot>/gradle/libs.versions.toml" or "<androidRoot>/libs.versions.toml").
 *
 * Deliberately SKIPS `classpath` lines (buildscript/plugin tooling versions
 * such as the Android Gradle Plugin or Kotlin compiler, not application
 * SDKs) - see the section banner comment above for why this collector can't
 * just reuse the legacy scan unmodified.
 *
 * Single-form note: the legacy addCoord above pushes BOTH the bare artifact
 * name and the full coordinate, because getDependencies() feeds a flat
 * SDK_MAP lookup that needs to try both shapes. The registry matcher
 * (src/engine/registry.ts) instead bridges a bare PATTERN to the artifact
 * segment of a full-coordinate DEP itself (see matchGradle there), so
 * emitting both forms here would make a single real dependency match twice
 * under a bare pattern (once as "artifact", once as the artifact segment of
 * "group:artifact") and produce two redundant matched_coordinates entries
 * for what is one SDK. Emitting only the full form keeps one dependency ->
 * one coordinate, with no loss of matching recall.
 */
function collectGradleCoordinates(androidRoot: string, gradleFiles: string[]): string[] {
  const catalog = new Map<string, string>();
  for (const p of [
    join(androidRoot, "gradle/libs.versions.toml"),
    join(androidRoot, "libs.versions.toml"),
  ]) {
    const content = readFileSafe(p);
    if (content) parseVersionCatalog(content, catalog);
  }

  const coordRegex =
    /['"]([a-zA-Z][\w.-]*\.[a-zA-Z][\w.-]*:[a-zA-Z][\w.-]*(?::[^'"\s]+)?)['"]/g;
  const libsRefRegex = /\blibs\.([a-zA-Z][\w.]*)/g;

  const deps: string[] = [];
  const addCoord = (coord: string) => {
    const parts = coord.split(":");
    if (parts.length < 2) return;
    const [group, artifact] = parts;
    if (!group || !artifact) return;
    deps.push(`${group}:${artifact}`);
  };

  for (const path of gradleFiles) {
    const content = readFileSafe(path);
    if (!content) continue;

    // Drop `classpath '...'` lines before scanning - see banner comment.
    const filtered = content
      .split("\n")
      .filter((line) => !/^\s*classpath\b/.test(line))
      .join("\n");

    for (const m of filtered.matchAll(coordRegex)) {
      addCoord(m[1]);
    }
    for (const m of filtered.matchAll(libsRefRegex)) {
      const ref = m[1];
      const resolved = catalog.get(ref) || catalog.get(ref.replace(/\./g, "-"));
      if (resolved) addCoord(resolved);
    }
  }

  return dedupeSorted(deps);
}

/** Extracts CocoaPods pod names from a Podfile at `podfilePath`, if present. */
function collectPodfilePods(podfilePath: string): string[] {
  const content = readFileSafe(podfilePath);
  if (!content) return [];
  const deps: string[] = [];
  for (const m of content.matchAll(/pod\s+['"]([^'"]+)['"]/g)) {
    deps.push(m[1]);
  }
  return dedupeSorted(deps);
}

/**
 * Extracts SPM package repo slugs from a standalone Package.swift
 * (`.package(url:...)`) and any project.pbxproj's XCRemoteSwiftPackageReference
 * `repositoryURL` entries, normalized to the repo SLUG: last URL path
 * component, ".git" suffix stripped, lowercased (per the registry matcher's
 * spm comparison contract - see src/engine/registry.ts).
 */
function collectSpmSlugs(rootDir: string): string[] {
  const deps: string[] = [];

  const packageSwift = readFileSafe(join(rootDir, "Package.swift"));
  if (packageSwift) {
    for (const m of packageSwift.matchAll(
      /\.package\([^)]*url:\s*"[^"]*\/([^/"]+?)(?:\.git)?"/g
    )) {
      deps.push(m[1].toLowerCase());
    }
  }

  const pbxprojPath = findFile(rootDir, "project.pbxproj", 5);
  if (pbxprojPath) {
    const pbxContent = readFileSafe(pbxprojPath);
    if (pbxContent) {
      for (const m of pbxContent.matchAll(
        /repositoryURL\s*=\s*"[^"]*\/([^/"]+?)(?:\.git)?"/g
      )) {
        deps.push(m[1].toLowerCase());
      }
    }
  }

  return dedupeSorted(deps);
}

/**
 * Raw (unfiltered) Swift + Objective-C module-import scan: every
 * `import X` / `@import X;` (Swift/ObjC) and `#import <Module/Header.h>`
 * (ObjC, angle-bracket form only) module name found in the project's
 * .swift/.m/.mm files (depth 6, capped at the first 100 files found -
 * mirrors the legacy scan's own limits above), deduped. Unlike the legacy
 * native-import scan in getDependencies() above, this is NOT gated by
 * SDK_MAP - the registry matcher needs to see every import (e.g. "UIKit"),
 * not just ones this file's hardcoded map happens to recognize.
 *
 * `#import "LocalHeader.h"` (quoted) is deliberately NOT matched: that's a
 * same-project header, not an external SDK, so it carries no SDK identity.
 */
function collectSwiftImports(rootDir: string): string[] {
  const sourceFiles = findFiles(rootDir, [".swift", ".m", ".mm"], 6);
  const imports = new Set<string>();
  for (const file of sourceFiles.slice(0, 100)) {
    const content = readFileSafe(file);
    if (!content) continue;
    for (const m of content.matchAll(/^\s*import\s+(\w+)/gm)) {
      imports.add(m[1]);
    }
    for (const m of content.matchAll(/@import\s+(\w+)\s*;/g)) {
      imports.add(m[1]);
    }
    // ObjC: `#import <Module/Header.h>` or `#import <Module.h>` - the
    // captured module segment is everything up to the first "/" (a
    // vendored SDK's umbrella header path) or the closing ">".
    for (const m of content.matchAll(/#import\s*<([^\/>]+)(?:\/[^>]*)?>/g)) {
      imports.add(m[1]);
    }
  }
  return dedupeSorted(Array.from(imports));
}

/**
 * Raw (unfiltered) Android import scan: every fully-qualified `import a.b.C`
 * target found in the project's .kt/.java files (multi-module: app/src at
 * depth 8 plus a project-wide depth-6 sweep, capped at 200 files - mirrors
 * the legacy scan's own limits above), deduped. Unlike the legacy scan above
 * (gated to a small curated prefix allowlist), this keeps the full imported
 * symbol (e.g. "com.google.android.gms.ads.AdView") so the registry
 * matcher's segment-boundary prefix matching can match it against any
 * package-prefix pattern, not just the handful this file already knows.
 */
function collectAndroidImports(rootDir: string): string[] {
  const files = [
    ...findFiles(join(rootDir, "app/src"), [".kt", ".java"], 8),
    ...findFiles(rootDir, [".kt", ".java"], 6),
  ];
  const seen = new Set<string>();
  const imports = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > 200) break;
    const content = readFileSafe(file);
    if (!content) continue;
    for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) {
      imports.add(m[1].replace(/\.$/, ""));
    }
  }
  return dedupeSorted(Array.from(imports));
}

/** Extracts pubspec.yaml `dependencies` + `dev_dependencies` package names. */
function collectPubspecDeps(pubspecPath: string): string[] {
  const content = readFileSafe(pubspecPath);
  if (!content) return [];
  const deps: string[] = [];
  try {
    const pubspec = YAML.parse(content);
    if (pubspec?.dependencies) deps.push(...Object.keys(pubspec.dependencies));
    if (pubspec?.dev_dependencies) deps.push(...Object.keys(pubspec.dev_dependencies));
  } catch {
    /* ignore */
  }
  return dedupeSorted(deps);
}

/** Extracts package.json `dependencies` + `devDependencies` package names. */
function collectPackageJsonDeps(pkgPath: string): string[] {
  const content = readFileSafe(pkgPath);
  if (!content) return [];
  const deps: string[] = [];
  try {
    const pkg = JSON.parse(content);
    if (pkg.dependencies) deps.push(...Object.keys(pkg.dependencies));
    if (pkg.devDependencies) deps.push(...Object.keys(pkg.devDependencies));
  } catch {
    /* ignore */
  }
  return dedupeSorted(deps);
}

/** Extracts .csproj `<PackageReference Include="...">` ids (root + depth-3 nested). */
function collectCsprojPackageRefs(rootDir: string): string[] {
  const csprojFiles: string[] = [];
  try {
    for (const entry of readdirSync(rootDir)) {
      if (entry.endsWith(".csproj")) csprojFiles.push(join(rootDir, entry));
    }
  } catch {
    /* ignore */
  }
  for (const f of findFiles(rootDir, [".csproj"], 3)) {
    if (!csprojFiles.includes(f)) csprojFiles.push(f);
  }

  const deps: string[] = [];
  for (const path of csprojFiles) {
    const content = readFileSafe(path);
    if (!content) continue;
    for (const m of content.matchAll(/<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/g)) {
      deps.push(m[1]);
    }
  }
  return dedupeSorted(deps);
}

/**
 * Collects a project's RAW (unfiltered) dependency surface for the
 * review-engine's registry-driven SDK matcher (src/engine/registry.ts).
 * Unlike scanSDKs()/getDependencies() above, nothing here is filtered
 * through SDK_MAP - every bucket always exists (possibly empty), deduped and
 * sorted, so matchSDKs() can compare it against arbitrary registry patterns.
 */
export function collectRawDependencies(rootDir: string, stack: TechStack): EcosystemDeps {
  const deps: EcosystemDeps = {
    npm: [],
    pub: [],
    pods: [],
    spm: [],
    gradle: [],
    nuget: [],
    upm: [],
    ios_imports: [],
    android_imports: [],
  };

  switch (stack) {
    case "flutter": {
      deps.pub = collectPubspecDeps(join(rootDir, "pubspec.yaml"));
      deps.pods = collectPodfilePods(join(rootDir, "ios", "Podfile"));
      const androidRoot = join(rootDir, "android");
      deps.gradle = collectGradleCoordinates(androidRoot, gradleCandidateFiles(androidRoot));
      // ios_imports/android_imports: none - Dart source, no native Swift/Kotlin scan here.
      break;
    }

    case "react-native":
    case "expo":
    case "capacitor": {
      deps.npm = collectPackageJsonDeps(join(rootDir, "package.json"));
      deps.pods = collectPodfilePods(join(rootDir, "ios", "Podfile"));
      const androidRoot = join(rootDir, "android");
      deps.gradle = collectGradleCoordinates(androidRoot, gradleCandidateFiles(androidRoot));
      break;
    }

    case "swift": {
      deps.pods = collectPodfilePods(join(rootDir, "Podfile"));
      deps.spm = collectSpmSlugs(rootDir);
      deps.ios_imports = collectSwiftImports(rootDir);
      break;
    }

    case "kotlin": {
      deps.gradle = collectGradleCoordinates(rootDir, gradleCandidateFiles(rootDir));
      deps.android_imports = collectAndroidImports(rootDir);
      break;
    }

    case "dotnet-maui": {
      deps.nuget = collectCsprojPackageRefs(rootDir);
      break;
    }

    case "unity": {
      // upm: dependency keys from Packages/manifest.json (Unity Package
      // Manager manifest) - this is Unity's equivalent of package.json.
      const manifestContent = readFileSafe(join(rootDir, "Packages", "manifest.json"));
      if (manifestContent) {
        try {
          const manifest = JSON.parse(manifestContent);
          if (manifest?.dependencies && typeof manifest.dependencies === "object") {
            deps.upm = dedupeSorted(Object.keys(manifest.dependencies));
          }
        } catch {
          /* malformed manifest.json - leave upm empty */
        }
      }

      // Unity plugin binaries vendored under Assets/Plugins/ (native SDKs
      // dropped in as raw .aar/.jar/.framework/.xcframework, since Unity has
      // no package-manifest entry for them) carry SDK identity in their bare
      // file/dir name alone. There is no build.gradle/Podfile to read at
      // this stage (the native Android/Xcode projects are generated at
      // build time), so the registry can only match these as bare
      // artifact/pod names - append them to the same buckets the
      // gradle/pods ecosystems already use for bare-name matching.
      const gradleFromPlugins: string[] = [];
      try {
        for (const entry of readdirSync(join(rootDir, "Assets", "Plugins", "Android"))) {
          if (entry.endsWith(".aar")) gradleFromPlugins.push(entry.slice(0, -".aar".length));
          else if (entry.endsWith(".jar")) gradleFromPlugins.push(entry.slice(0, -".jar".length));
        }
      } catch {
        /* Assets/Plugins/Android/ absent - most Unity apps don't have it */
      }
      deps.gradle = dedupeSorted(gradleFromPlugins);

      const podsFromPlugins: string[] = [];
      try {
        for (const entry of readdirSync(join(rootDir, "Assets", "Plugins", "iOS"))) {
          if (entry.endsWith(".xcframework")) podsFromPlugins.push(entry.slice(0, -".xcframework".length));
          else if (entry.endsWith(".framework")) podsFromPlugins.push(entry.slice(0, -".framework".length));
        }
      } catch {
        /* Assets/Plugins/iOS/ absent */
      }
      deps.pods = dedupeSorted(podsFromPlugins);
      break;
    }

    case "kmp": {
      // gradle: the existing multi-module coordinate collector already
      // walks the whole tree (gradleCandidateFiles + collectGradleCoordinates
      // recurse to depth 5), so it reaches both shared/build.gradle.kts and
      // androidApp/build.gradle.kts from rootDir directly.
      deps.gradle = collectGradleCoordinates(rootDir, gradleCandidateFiles(rootDir));

      // iOS side lives under iosApp/ in the conventional KMP project layout.
      const iosAppDir = join(rootDir, "iosApp");
      deps.ios_imports = collectSwiftImports(iosAppDir);
      deps.pods = collectPodfilePods(join(iosAppDir, "Podfile"));
      deps.spm = collectSpmSlugs(iosAppDir);

      // Android + shared Kotlin sources: collectAndroidImports already
      // sweeps rootDir (depth 6) plus app/src (depth 8), which covers every
      // KMP module (shared/, androidApp/) from a single rootDir-wide call.
      deps.android_imports = collectAndroidImports(rootDir);
      break;
    }

    // "unknown" only.
    default:
      break;
  }

  return deps;
}
