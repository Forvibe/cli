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
// version 2.0.2 after the omitted-vs-null contract fix wave), imported
// directly - never via the network loader.
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

it("snapshot is the 2.0.2 rulepack (omitted-vs-null contract fix synced)", () => {
  expect(bundle.version).toBe("2.0.2");
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
