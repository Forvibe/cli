import { describe, it, expect } from "vitest";
import { scanSourceSignals } from "../../src/engine/profile-builder.js";
import { runStaticEngine } from "../../src/engine/index.js";
import { detectTechStack } from "../../src/analyzers/tech-detector.js";
import { parseConfig } from "../../src/analyzers/config-parser.js";
import { fixturePath } from "../helpers/fixture-path.js";
import { loadSnapshotBundle } from "../helpers/load-bundle.js";
import type { AppProfile } from "../../src/engine/types.js";

const bundle = loadSnapshotBundle();

/** Builds a fixture's AppProfile through the full engine (self-scans source). */
function profileFor(fixture: string): AppProfile {
  const rootDir = fixturePath(fixture);
  const stackResult = detectTechStack(rootDir);
  const cfg = parseConfig(rootDir, stackResult.stack);
  return runStaticEngine({
    rootDir,
    stackResult,
    appConfig: {
      app_name: cfg.app_name,
      bundle_id: cfg.bundle_id,
      version: cfg.version,
      min_ios_version: cfg.min_ios_version,
      min_android_sdk: cfg.min_android_sdk,
    },
    bundle,
    generatedAt: "2026-07-09T00:00:00.000Z",
  }).profile;
}

// ===========================================================================
// scanSourceSignals — precise pattern behavior
// ===========================================================================

describe("scanSourceSignals", () => {
  it("detects restore, deletion, creation, privacy-policy, external checkout", () => {
    const s = scanSourceSignals({
      files: [
        { path: "a.ts", content: "func restorePurchases() {}" },
        { path: "b.ts", content: "async function deleteAccount() {}" },
        { path: "c.ts", content: "export function signUp() {}" },
        { path: "d.ts", content: "<a href='/privacy-policy'>Privacy Policy</a>" },
        { path: "e.ts", content: "const url = 'https://buy.stripe.com/xyz'" },
      ],
    });
    expect(s.restore_purchases_found).toBe(true);
    expect(s.account_deletion_found).toBe(true);
    expect(s.account_creation_found).toBe(true);
    expect(s.privacy_policy_link_found).toBe(true);
    expect(s.external_checkout_url_found).toBe(true);
    expect(s.scanned_files).toBe(5);
  });

  it("matches account deletion via the loose 'account ... delet' proximity pattern (case-insensitive)", () => {
    const s = scanSourceSignals({ files: [{ path: "x.kt", content: "fun purgeAccountAndDeleteData() {}" }] });
    expect(s.account_deletion_found).toBe(true);
  });

  it("account creation is case-sensitive on identifiers (signUp matches, signup does not)", () => {
    expect(scanSourceSignals({ files: [{ path: "a", content: "signUp()" }] }).account_creation_found).toBe(true);
    expect(scanSourceSignals({ files: [{ path: "a", content: "we let users signup here" }] }).account_creation_found).toBe(false);
  });

  it("computes webview_ratio = webview_files / max(scanned,1) rounded to 2 decimals", () => {
    const s = scanSourceSignals({
      files: [
        { path: "1", content: "import WKWebView" },
        { path: "2", content: "const x = new InAppWebView()" },
        { path: "3", content: "plain code" },
      ],
    });
    expect(s.webview_files).toBe(2);
    expect(s.webview_ratio).toBe(0.67); // 2/3 -> 0.67
  });

  it("returns false/0 signals for empty input (webview_ratio 0, not NaN)", () => {
    const s = scanSourceSignals({ files: [] });
    expect(s.restore_purchases_found).toBe(false);
    expect(s.webview_ratio).toBe(0);
    expect(s.scanned_files).toBe(0);
    expect(s.source_chars).toBe(0);
  });

  it("no false positives on unrelated code", () => {
    const s = scanSourceSignals({ files: [{ path: "a", content: "function greet() { return 'hi'; }" }] });
    expect(s.restore_purchases_found).toBe(false);
    expect(s.account_deletion_found).toBe(false);
    expect(s.account_creation_found).toBe(false);
    expect(s.privacy_policy_link_found).toBe(false);
    expect(s.external_checkout_url_found).toBe(false);
    expect(s.webview_files).toBe(0);
  });
});

// ===========================================================================
// buildAppProfile via the engine — fixture-driven (against the REAL snapshot)
// ===========================================================================

describe("buildAppProfile (fixture-driven)", () => {
  it("swift-app: capabilities + signals + evidence from planted facts", () => {
    const p = profileFor("swift-app");
    expect(p.platforms).toEqual(["ios"]);
    expect(p.sdks.map((s) => s.id)).toEqual(["appsflyer", "google-mobile-ads", "storekit"]);
    // sign_in_with_apple (entitlement) + push_notifications (aps-environment) +
    // camera (NSCameraUsageDescription) + account_creation (createAccount) +
    // iap (storekit implies) + ads (admob implies) + photos (NSPhotoLibrary key present)
    expect(p.capabilities).toEqual(
      expect.arrayContaining([
        "account_creation",
        "ads",
        "camera",
        "iap",
        "photos",
        "push_notifications",
        "sign_in_with_apple",
      ])
    );
    // capabilities are sorted + deduped
    expect(p.capabilities).toEqual([...p.capabilities].sort());
    // no health/tracking here
    expect(p.capabilities).not.toContain("tracking");
    expect(p.capabilities).not.toContain("health");
    // signals: source scanned -> concrete booleans (not null)
    expect(p.signals.account_deletion_found).toBe(false);
    expect(p.signals.restore_purchases_found).toBe(false);
    // evidence non-empty (extractor maps + sdks origin)
    expect(Object.keys(p.evidence).length).toBeGreaterThan(0);
    expect(p.evidence["sdks"]?.file).toBe("Podfile");
    expect(p.stats.files_scanned).toBeGreaterThan(0);
  });

  it("flutter-app: health + iap + ads; restore true; NOT subscriptions", () => {
    const p = profileFor("flutter-app");
    expect(p.platforms).toEqual(["ios", "android"]);
    expect(p.capabilities).toEqual(expect.arrayContaining(["ads", "health", "iap"]));
    // in_app_purchase implies iap only, not subscriptions
    expect(p.capabilities).not.toContain("subscriptions");
    expect(p.signals.restore_purchases_found).toBe(true);
    // health derived from both the ACTIVITY_RECOGNITION permission and the
    // NSHealthShareUsageDescription usage description.
    expect(p.capabilities).toContain("health");
  });

  it("kotlin-app: location + camera from permissions; ads from gradle; ios null", () => {
    const p = profileFor("kotlin-app");
    expect(p.platforms).toEqual(["android"]);
    expect(p.ios).toBeNull();
    expect(p.capabilities).toEqual(expect.arrayContaining(["ads", "camera", "iap", "location"]));
    expect(p.sdks.map((s) => s.id)).toEqual(["google-mobile-ads", "play-billing"]);
    // target/min android sdk carried from gradle-targets extractor
    expect(p.app.target_android_sdk).toBe(34);
    expect(p.app.min_android_sdk).toBe(24);
  });

  it("expo-app: camera + iap + subscriptions + account_creation + microphone", () => {
    const p = profileFor("expo-app");
    expect(p.capabilities).toEqual(
      expect.arrayContaining(["account_creation", "camera", "iap", "microphone", "subscriptions"])
    );
    // camera comes from the camera-access SDK implies; microphone from the
    // NSMicrophoneUsageDescription usage description in the expo config.
    expect(p.ios?.plist_source).toBe("expo_config");
  });

  it("swift-modern-app: camera from pbxproj INFOPLIST_KEY; non_exempt_encryption false", () => {
    const p = profileFor("swift-modern-app");
    expect(p.sdks).toEqual([]);
    expect(p.capabilities).toContain("camera");
    expect(p.ios?.plist_source).toBe("pbxproj_infoplist_keys");
    expect(p.ios?.plist?.non_exempt_encryption).toBe(false);
  });

  it("does NOT derive capabilities from background_modes (audio present, no background_audio)", () => {
    // swift-app plants UIBackgroundModes=[audio]; deriving background_audio
    // from it would make the background-mode rules tautological.
    const p = profileFor("swift-app");
    expect(p.ios?.plist?.background_modes).toContain("audio");
    expect(p.capabilities).not.toContain("background_audio");
  });
});
