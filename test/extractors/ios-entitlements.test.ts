import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractIosEntitlements } from "../../src/engine/extractors/ios-entitlements.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("extractIosEntitlements", () => {
  it("swift-app: reads aps-environment and Sign in with Apple from MyApp.entitlements", () => {
    const result = extractIosEntitlements(fixturePath("swift-app"));

    expect(result.entitlements).not.toBeNull();
    const entitlements = result.entitlements!;
    expect(entitlements.aps_environment).toBe("development");
    expect(entitlements.sign_in_with_apple).toBe(true);
    expect(entitlements.healthkit).toBe(false);
    expect(entitlements.associated_domains).toEqual([]);
    expect(entitlements.app_groups).toEqual([]);
    expect(entitlements.keys).toEqual(
      ["aps-environment", "com.apple.developer.applesignin"].sort()
    );
  });

  it("expo-app: returns null when no .entitlements files exist", () => {
    const result = extractIosEntitlements(fixturePath("expo-app"));
    expect(result.entitlements).toBeNull();
  });

  describe("extension-only entitlements", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("falls back to extension entitlements when no main-target file exists, and notes it in evidence", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-ios-entitlements-ext-"));
      const widgetDir = path.join(dir, "MyAppWidget");
      mkdirSync(widgetDir, { recursive: true });
      writeFileSync(
        path.join(widgetDir, "MyAppWidget.entitlements"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>group.com.forvibe.fixture</string>
	</array>
</dict>
</plist>
`,
        "utf-8"
      );

      const result = extractIosEntitlements(dir);
      expect(result.entitlements).not.toBeNull();
      expect(result.entitlements!.app_groups).toEqual(["group.com.forvibe.fixture"]);
      const evidenceValues = Object.values(result.evidence);
      expect(evidenceValues.some((e) => (e.detail ?? "").toLowerCase().includes("extension"))).toBe(
        true
      );
    });
  });
});
