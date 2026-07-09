import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runStaticEngine, type StaticEngineResult } from "../../src/engine/index.js";
import { detectTechStack } from "../../src/analyzers/tech-detector.js";
import { parseConfig } from "../../src/analyzers/config-parser.js";
import { fixturePath } from "../helpers/fixture-path.js";
import { loadSnapshotBundle } from "../helpers/load-bundle.js";
import type { CheckStatus } from "../../src/engine/types.js";

// Integration tests run against the COMMITTED snapshot (bundle.appstore.json,
// version 2.1.0 after the content expansion wave: 30 rules, 118 registry
// entries), imported directly - never via the network loader.
const bundle = loadSnapshotBundle();

function runFixture(fixture: string): StaticEngineResult {
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
  });
}

function statusMap(result: StaticEngineResult): Record<string, CheckStatus> {
  const map: Record<string, CheckStatus> = {};
  for (const c of result.checks) map[c.rule_id] = c.status;
  return map;
}

it("snapshot is the 2.1.0 rulepack (content expansion: 30 rules / 118 SDKs synced)", () => {
  expect(bundle.version).toBe("2.1.0");
});

// ===========================================================================
// swift-app
// ===========================================================================

describe("swift-app integration", () => {
  const result = runFixture("swift-app");
  const status = statusMap(result);

  it("att-usage-description-missing -> fail (AppsFlyer att_required, no NSUserTrackingUsageDescription)", () => {
    expect(status["appstore.att-usage-description-missing"]).toBe("fail");
  });

  it("ats-arbitrary-loads -> fail (NSAllowsArbitraryLoads true)", () => {
    expect(status["appstore.ats-arbitrary-loads"]).toBe("fail");
  });

  it("encryption-declaration-missing -> fail (key genuinely absent -> property omitted -> MISSING -> absent true)", () => {
    expect(status["appstore.encryption-declaration-missing"]).toBe("fail");
  });

  it("account-deletion-missing -> fail (createAccount found, no deletion signal)", () => {
    expect(status["appstore.account-deletion-missing"]).toBe("fail");
  });

  it("sign-in-with-apple-missing -> na (no third_party_login capability)", () => {
    expect(status["appstore.sign-in-with-apple-missing"]).toBe("na");
  });

  it("healthkit-with-ads -> na (no health capability)", () => {
    expect(status["appstore.healthkit-with-ads"]).toBe("na");
  });

  it("privacy-policy-link-missing -> fail (ads/attribution SDKs present, no privacy-policy string in scanned source) [new in 2.1.0]", () => {
    expect(status["appstore.privacy-policy-link-missing"]).toBe("fail");
  });

  it("skadnetwork-missing-with-ads -> pass (Info.plist carries SKAdNetworkItems entries) [new in 2.1.0]", () => {
    expect(status["appstore.skadnetwork-missing-with-ads"]).toBe("pass");
  });

  it("background-audio-unjustified -> unverified (UIBackgroundModes=[audio] declared; playback is behavioral) [new in 2.1.0]", () => {
    expect(status["appstore.background-audio-unjustified"]).toBe("unverified");
  });

  it("admob-app-id-missing -> fail (GAD key genuinely absent -> property omitted -> MISSING -> absent true)", () => {
    expect(status["appstore.admob-app-id-missing"]).toBe("fail");
  });

  it("findings exist only for fail checks and are static", () => {
    const failCheckIds = result.checks.filter((c) => c.status === "fail").map((c) => c.rule_id).sort();
    const findingIds = result.findings.map((f) => f.rule_id).sort();
    expect(findingIds).toEqual(failCheckIds);
    for (const f of result.findings) {
      expect(f.detection).toBe("static");
      expect(f.source).toBe("codebase");
      expect(f.rule_id).toBe(f.id);
    }
  });

  it("the att finding carries a file hint from the dependency manifest", () => {
    const att = result.findings.find((f) => f.rule_id === "appstore.att-usage-description-missing");
    expect(att?.file).toBe("Podfile");
    // {{sdk_names}} (in the description/fix) interpolated to the att_required SDK display names
    expect(att?.description).toContain("AppsFlyer");
    expect(att?.description).toContain("Google AdMob (Mobile Ads SDK)");
  });

  it("emits exactly one check per non-template rule (no rule dropped)", () => {
    const nonTemplateRuleIds = bundle.rules.filter((r) => !r.template).map((r) => r.id);
    for (const id of nonTemplateRuleIds) {
      expect(result.checks.some((c) => c.rule_id === id)).toBe(true);
    }
    // total checks >= non-template rule count (template expansion only adds)
    expect(result.checks.length).toBeGreaterThanOrEqual(nonTemplateRuleIds.length);
  });
});

// ===========================================================================
// swift-modern-app
// ===========================================================================

describe("swift-modern-app integration", () => {
  const status = statusMap(runFixture("swift-modern-app"));

  it("att-usage-description-missing -> na (no tracking SDK, no Podfile)", () => {
    expect(status["appstore.att-usage-description-missing"]).toBe("na");
  });

  it("encryption-declaration-missing -> pass (INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO)", () => {
    expect(status["appstore.encryption-declaration-missing"]).toBe("pass");
  });
});

// ===========================================================================
// expo-app
// ===========================================================================

describe("expo-app integration", () => {
  const result = runFixture("expo-app");
  const status = statusMap(result);

  it("synthesizes appstore.sdk-plist.camera-access.NSCameraUsageDescription -> fail", () => {
    // expo config declares only NSMicrophoneUsageDescription; the camera key is missing.
    expect(status["appstore.sdk-plist.camera-access.NSCameraUsageDescription"]).toBe("fail");
  });

  it("synthesizes both required UsageDescription keys for camera-access (Camera + PhotoLibrary)", () => {
    expect(status["appstore.sdk-plist.camera-access.NSPhotoLibraryUsageDescription"]).toBe("fail");
  });

  it("does NOT emit the raw template rule as a check", () => {
    expect(status["appstore.sdk-required-plist-key-missing"]).toBeUndefined();
  });

  it("synthesized fail finding interpolates the concrete plist key + reason", () => {
    const f = result.findings.find(
      (f) => f.rule_id === "appstore.sdk-plist.camera-access.NSCameraUsageDescription"
    );
    expect(f?.description).toContain("NSCameraUsageDescription");
    expect(f?.recommendation).toContain("NSCameraUsageDescription");
    expect(f?.recommendation).toContain("Required to access the camera");
    expect(f?.guideline_number).toBe("5.1.1");
  });
});

// ===========================================================================
// flutter-app
// ===========================================================================

describe("flutter-app integration", () => {
  const status = statusMap(runFixture("flutter-app"));

  it("att-usage-description-missing -> fail (google_mobile_ads att_required, plist present, no key)", () => {
    expect(status["appstore.att-usage-description-missing"]).toBe("fail");
  });

  it("healthkit-with-ads -> fail (health capability + ads category SDK)", () => {
    expect(status["appstore.healthkit-with-ads"]).toBe("fail");
  });

  it("subscription-without-restore -> na (no subscriptions capability)", () => {
    expect(status["appstore.subscription-without-restore"]).toBe("na");
  });

  it("admob-app-id-missing -> fail (GAD key genuinely absent from the flutter Info.plist)", () => {
    expect(status["appstore.admob-app-id-missing"]).toBe("fail");
  });

  it("healthkit matched via the pub 'health' plugin; template fails the missing NSHealthUpdateUsageDescription while the present Share key passes [new in 2.1.0]", () => {
    expect(status["appstore.sdk-plist.healthkit.NSHealthUpdateUsageDescription"]).toBe("fail");
    expect(status["appstore.sdk-plist.healthkit.NSHealthShareUsageDescription"]).toBe("pass");
  });

  it("health-privacy-policy-missing -> fail (health capability, no privacy-policy string in scanned source) [new in 2.1.0]", () => {
    expect(status["appstore.health-privacy-policy-missing"]).toBe("fail");
  });
});

// ===========================================================================
// kotlin-app (android only)
// ===========================================================================

describe("kotlin-app integration", () => {
  const status = statusMap(runFixture("kotlin-app"));

  it("every ios-gated rule is na (platform android only)", () => {
    expect(status["appstore.att-usage-description-missing"]).toBe("na");
    expect(status["appstore.encryption-declaration-missing"]).toBe("na");
    expect(status["appstore.ats-arbitrary-loads"]).toBe("na");
  });
});

// ===========================================================================
// objc-app (stack "swift" - ObjC-only project, new label)
// ===========================================================================

describe("objc-app integration", () => {
  const result = runFixture("objc-app");
  const status = statusMap(result);

  it("admob-app-id-missing -> fail (GoogleMobileAds .m import matched, plist present without GAD)", () => {
    expect(status["appstore.admob-app-id-missing"]).toBe("fail");
  });

  it("att-usage-description-missing -> fail (google-mobile-ads att_required, plist present, no key)", () => {
    expect(status["appstore.att-usage-description-missing"]).toBe("fail");
  });

  it("account-deletion-missing -> fail (createAccount present in AppDelegate.m, no deletion signal)", () => {
    expect(status["appstore.account-deletion-missing"]).toBe("fail");
  });

  it("firebase-core matched via '@import FirebaseCore;' (T4 gap closed in registry 2.1.0)", () => {
    expect(result.profile.sdks.map((s) => s.id)).toContain("firebase-core");
  });

  it("skadnetwork-missing-with-ads -> fail, info severity (ads SDK present, plist has no SKAdNetworkItems) [new in 2.1.0]", () => {
    expect(status["appstore.skadnetwork-missing-with-ads"]).toBe("fail");
    const check = result.checks.find((c) => c.rule_id === "appstore.skadnetwork-missing-with-ads");
    expect(check?.severity).toBe("info");
  });
});

// ===========================================================================
// unity-app
// ===========================================================================

describe("unity-app integration", () => {
  const result = runFixture("unity-app");
  const status = statusMap(result);

  it("att-usage-description-missing -> unverified (unity-ads att_required matched via upm, but ios.plist stays null - no pre-build iOS artifacts)", () => {
    expect(status["appstore.att-usage-description-missing"]).toBe("unverified");
  });

  it("applovin-max matched via the vendored AAR basename against the 'applovin-sdk*' gradle prefix pattern (T4 gap closed in registry 2.1.0)", () => {
    const applovin = result.profile.sdks.find((s) => s.id === "applovin-max");
    expect(applovin?.matched_coordinates).toEqual(["gradle:applovin-sdk-12.1.0"]);
    // The ATT rule already applied via unity-ads; applovin joining the
    // att_required set must not change the (plist-null) unverified outcome.
    expect(status["appstore.att-usage-description-missing"]).toBe("unverified");
  });

  it("unity-iap matched via upm com.unity.purchasing [new in 2.1.0]", () => {
    expect(result.profile.sdks.map((s) => s.id)).toContain("unity-iap");
  });

  it("encryption-declaration-missing -> unverified (ios.plist null)", () => {
    expect(status["appstore.encryption-declaration-missing"]).toBe("unverified");
  });

  it("profile.app.bundle_id resolves to the ProjectSettings.asset value end-to-end (via parseConfig's own unity case)", () => {
    expect(result.profile.app.bundle_id).toBe("com.forvibe.fixture.unity");
  });

  it("profile.platforms includes both ios and android", () => {
    expect(result.profile.platforms).toEqual(["ios", "android"]);
  });

  // The test above goes through parseConfig() first, which (via its own new
  // unity case) already fills appConfig.bundle_id/app_name/version before
  // runStaticEngine ever sees it - so it never actually exercises the
  // orchestrator's OWN "fill profile.app when the caller's appConfig lacks
  // them" fallback (extractUnityProjectSettings called directly inside
  // index.ts). Prove that path independently by calling runStaticEngine with
  // a deliberately empty appConfig, simulating a caller that never ran
  // parseConfig.
  it("orchestrator's own appConfig-fallback fills app_name/bundle_id/version when the caller supplies nulls", () => {
    const rootDir = fixturePath("unity-app");
    const stackResult = detectTechStack(rootDir);
    const result = runStaticEngine({
      rootDir,
      stackResult,
      appConfig: { app_name: null, bundle_id: null, version: null },
      bundle,
      generatedAt: "2026-07-09T00:00:00.000Z",
    });

    expect(result.profile.app.bundle_id).toBe("com.forvibe.fixture.unity");
    expect(result.profile.app.name).toBe("FixtureUnity");
    expect(result.profile.app.version).toBe("0.3.0");
  });

  it("orchestrator's appConfig-fallback does NOT override an explicit caller-supplied value", () => {
    const rootDir = fixturePath("unity-app");
    const stackResult = detectTechStack(rootDir);
    const result = runStaticEngine({
      rootDir,
      stackResult,
      appConfig: { app_name: "CallerName", bundle_id: "com.caller.explicit", version: "9.9.9" },
      bundle,
      generatedAt: "2026-07-09T00:00:00.000Z",
    });

    expect(result.profile.app.bundle_id).toBe("com.caller.explicit");
    expect(result.profile.app.name).toBe("CallerName");
    expect(result.profile.app.version).toBe("9.9.9");
  });
});

// ===========================================================================
// kmp-app
// ===========================================================================

describe("kmp-app integration", () => {
  const result = runFixture("kmp-app");
  const status = statusMap(result);

  it("camera capability present (from iosApp/iosApp/Info.plist NSCameraUsageDescription)", () => {
    expect(result.profile.capabilities).toContain("camera");
  });

  it("att-usage-description-missing -> fail (play-services-ads att_required + iosApp plist present without the key)", () => {
    expect(status["appstore.att-usage-description-missing"]).toBe("fail");
  });

  it("profile.platforms == ['ios', 'android']", () => {
    expect(result.profile.platforms).toEqual(["ios", "android"]);
  });

  it("android manifest was read from the androidApp/ module dir (not rootDir)", () => {
    expect(result.profile.android?.manifest_found).toBe(true);
    expect(result.profile.android?.permissions).toContain("android.permission.INTERNET");
    expect(result.profile.android?.permissions).toContain("android.permission.CAMERA");
  });

  it("gradle targets were read from the androidApp/ module's own build.gradle.kts", () => {
    expect(result.profile.app.min_android_sdk).toBe(24);
    expect(result.profile.app.target_android_sdk).toBe(34);
  });

  // The evidence file paths are relative to the root each extractor was
  // actually called with. A bare "src/main/AndroidManifest.xml" /
  // "build.gradle.kts" / single-segment "iosApp/Info.plist" is only possible
  // when the orchestrator passed the resolved module dir (androidModuleDir /
  // iosAppDir) as that root - if it had fallen back to plain rootDir instead,
  // these paths would carry an extra "androidApp/" or "iosApp/" prefix (or,
  // for the plist, a doubled "iosApp/iosApp/"). This is a stronger proof of
  // the module-scoped wiring than the value-only assertions above, which a
  // recursive-fallback scan could satisfy by coincidence even with the wrong
  // root.
  it("evidence file paths confirm the shared extractors ran against the resolved module dirs, not rootDir", () => {
    expect(result.profile.evidence["android.manifest"]?.file).toBe("src/main/AndroidManifest.xml");
    expect(result.profile.evidence["android.gradle"]?.file).toBe("build.gradle.kts");
    expect(result.profile.evidence["ios.plist.plist_file"]?.file).toBe("iosApp/Info.plist");
  });

  it("account_creation capability detected from shared/ Kotlin source (signUp() in commonMain)", () => {
    expect(result.profile.capabilities).toContain("account_creation");
  });
});

// ===========================================================================
// Ordering + determinism
// ===========================================================================

describe("ordering + determinism", () => {
  it("checks are ordered fail, unverified, pass, na", () => {
    const order: Record<CheckStatus, number> = { fail: 0, unverified: 1, pass: 2, na: 3 };
    const checks = runFixture("swift-app").checks;
    for (let i = 1; i < checks.length; i++) {
      expect(order[checks[i].status]).toBeGreaterThanOrEqual(order[checks[i - 1].status]);
    }
  });

  it("findings are ordered by severity high -> info", () => {
    const sev: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
    const findings = runFixture("swift-app").findings;
    for (let i = 1; i < findings.length; i++) {
      expect(sev[findings[i].risk_level]).toBeGreaterThanOrEqual(sev[findings[i - 1].risk_level]);
    }
  });

  it("is deterministic: two runs on swift-app deep-equal", () => {
    const a = runFixture("swift-app");
    const b = runFixture("swift-app");
    expect(a).toEqual(b);
  });

  it("is deterministic: two runs on unity-app deep-equal", () => {
    const a = runFixture("unity-app");
    const b = runFixture("unity-app");
    expect(a).toEqual(b);
  });
});

// ===========================================================================
// End-to-end pin: $(VAR)-valued GAD id -> NULLVALUE -> unverified
// ===========================================================================

describe("build-variable GAD id end-to-end", () => {
  it("AdMob pod + GADApplicationIdentifier = $(GAD_APP_ID) -> admob check unverified (not fail)", () => {
    // Pins the two-link chain in one end-to-end test: the extractor keeps a
    // $(VAR)-valued key PRESENT with null, and the evaluator resolves
    // NULLVALUE under op `absent` to unknown -> unverified. A false fail here
    // would punish apps that inject the AdMob id via build settings.
    const dir = mkdtempSync(path.join(tmpdir(), "rsv2-e2e-gad-var-"));
    try {
      writeFileSync(
        path.join(dir, "Podfile"),
        "platform :ios, '15.0'\n\ntarget 'VarApp' do\n  pod 'Google-Mobile-Ads-SDK'\nend\n",
        "utf-8"
      );
      writeFileSync(
        path.join(dir, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>VarApp</string>
	<key>GADApplicationIdentifier</key>
	<string>$(GAD_APP_ID)</string>
</dict>
</plist>
`,
        "utf-8"
      );

      const stackResult = detectTechStack(dir);
      expect(stackResult.stack).toBe("swift"); // Podfile marks it as an iOS project
      const cfg = parseConfig(dir, stackResult.stack);
      const result = runStaticEngine({
        rootDir: dir,
        stackResult,
        appConfig: { app_name: cfg.app_name, bundle_id: cfg.bundle_id },
        bundle,
        generatedAt: "2026-07-09T00:00:00.000Z",
      });

      const admob = result.checks.find((c) => c.rule_id === "appstore.admob-app-id-missing");
      expect(admob?.status).toBe("unverified");
      // And no finding is emitted for an unverified check.
      expect(
        result.findings.some((f) => f.rule_id === "appstore.admob-app-id-missing")
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
