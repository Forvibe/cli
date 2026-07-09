import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractIosPrivacyManifest } from "../../src/engine/extractors/ios-privacy-manifest.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("extractIosPrivacyManifest", () => {
  it("swift-app: reads the app's PrivacyInfo.xcprivacy", () => {
    const { privacy_manifest } = extractIosPrivacyManifest(fixturePath("swift-app"));

    expect(privacy_manifest.app_manifest_present).toBe(true);
    expect(privacy_manifest.collected_data_types).toContain(
      "NSPrivacyCollectedDataTypeEmailAddress"
    );
    expect(privacy_manifest.accessed_api_types).toContain(
      "NSPrivacyAccessedAPICategoryUserDefaults"
    );
    expect(privacy_manifest.tracking).toBe(false);
    expect(privacy_manifest.tracking_domains).toEqual([]);
    expect(privacy_manifest.sdk_manifests_found).toBe(0);
  });

  it("expo-app: app_manifest_present is false when no .xcprivacy file exists", () => {
    const { privacy_manifest } = extractIosPrivacyManifest(fixturePath("expo-app"));

    expect(privacy_manifest.app_manifest_present).toBe(false);
    expect(privacy_manifest.collected_data_types).toEqual([]);
    expect(privacy_manifest.accessed_api_types).toEqual([]);
    expect(privacy_manifest.tracking).toBeNull();
    expect(privacy_manifest.tracking_domains).toEqual([]);
    expect(privacy_manifest.sdk_manifests_found).toBe(0);
  });

  describe("multiple manifests on disk", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("treats the shortest path as the app manifest and counts the rest as sdk_manifests_found", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-ios-privacy-multi-"));
      writeFileSync(
        path.join(dir, "PrivacyInfo.xcprivacy"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<true/>
</dict>
</plist>
`,
        "utf-8"
      );
      const vendoredDir = path.join(dir, "Vendor", "SomeSDK.xcframework");
      mkdirSync(vendoredDir, { recursive: true });
      writeFileSync(
        path.join(vendoredDir, "PrivacyInfo.xcprivacy"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
</dict>
</plist>
`,
        "utf-8"
      );

      const { privacy_manifest } = extractIosPrivacyManifest(dir);
      expect(privacy_manifest.app_manifest_present).toBe(true);
      expect(privacy_manifest.tracking).toBe(true); // root file, not the vendored one
      expect(privacy_manifest.sdk_manifests_found).toBe(1);
    });
  });
});
