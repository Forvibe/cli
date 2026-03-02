import { join } from "path";
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

  // --- Native Android frameworks (detected via `import` in Kotlin/Java source) ---
  "com.google.android.gms.ads": { category: "ads", collects: ["device_info"], advertising: "personalized" },
  "com.google.android.gms.maps": { category: "other", collects: ["location"] },
  "com.google.android.gms.location": { category: "other", collects: ["location"] },
  "com.google.android.gms.auth": { category: "auth", collects: ["name_email", "profile_photo"] },
  "com.android.billingclient": { category: "payment", collects: ["financial_info"] },
  "androidx.health": { category: "other", collects: ["health_data"] },
  "androidx.biometric": { category: "auth", collects: ["biometric_data"] },
  "androidx.camera": { category: "other", collects: ["photos_media"] },
};

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

    case "kotlin":
    case "java": {
      const gradlePaths = [
        join(rootDir, "app/build.gradle"),
        join(rootDir, "app/build.gradle.kts"),
        join(rootDir, "build.gradle"),
        join(rootDir, "build.gradle.kts"),
      ];
      for (const path of gradlePaths) {
        const content = readFileSafe(path);
        if (content) {
          const implMatches = content.matchAll(
            /implementation\s*\(?['"]([^'"]+)['"]\)?/g
          );
          for (const match of implMatches) {
            const parts = match[1].split(":");
            if (parts.length >= 2) {
              deps.push(parts[1]); // artifact name
            }
          }
        }
      }
      // Native Android framework imports from Kotlin/Java source files
      const androidFiles = findFiles(join(rootDir, "app/src"), [".kt", ".java"], 8);
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
      ];
      for (const file of androidFiles.slice(0, 100)) {
        const content = readFileSafe(file);
        if (!content) continue;
        for (const prefix of androidFrameworkPrefixes) {
          if (content.includes(`import ${prefix}`)) {
            if (!androidNativeImports.has(prefix)) {
              androidNativeImports.add(prefix);
            }
          }
        }
      }
      deps.push(...androidNativeImports);
      break;
    }
  }

  return deps;
}
