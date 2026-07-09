import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractIosPlist } from "../../src/engine/extractors/ios-plist.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("extractIosPlist", () => {
  it("swift-app: reads Info.plist file values exactly", () => {
    const result = extractIosPlist(fixturePath("swift-app"));

    expect(result.plist_source).toBe("plist_file");
    expect(result.plist).not.toBeNull();
    const plist = result.plist!;

    expect(plist.usage_descriptions.NSCameraUsageDescription).toBe(
      "We scan receipts with your camera."
    );
    expect("NSUserTrackingUsageDescription" in plist.usage_descriptions).toBe(false);
    expect(plist.ats_allows_arbitrary_loads).toBe(true);
    expect(plist.sk_ad_network_count).toBe(2);
    expect(plist.non_exempt_encryption).toBeNull();
    expect(plist.background_modes).toEqual(["audio"]);
    expect(plist.required_device_capabilities).toEqual(["arm64"]);
    expect(plist.gad_application_identifier).toBeNull();
  });

  it("swift-app: unresolved $(VAR) usage-description value is null while the key is present", () => {
    const result = extractIosPlist(fixturePath("swift-app"));
    const plist = result.plist!;

    expect("NSPhotoLibraryUsageDescription" in plist.usage_descriptions).toBe(true);
    expect(plist.usage_descriptions.NSPhotoLibraryUsageDescription).toBeNull();
  });

  it("swift-modern-app: derives plist entirely from pbxproj INFOPLIST_KEY_* build settings", () => {
    const result = extractIosPlist(fixturePath("swift-modern-app"));

    expect(result.plist_source).toBe("pbxproj_infoplist_keys");
    expect(result.plist).not.toBeNull();
    expect(result.plist!.usage_descriptions.NSCameraUsageDescription).toBe(
      "Camera for scanning documents"
    );
    expect(result.plist!.non_exempt_encryption).toBeNull();
  });

  it("expo-app: derives plist from app.json expo.ios.infoPlist", () => {
    const result = extractIosPlist(fixturePath("expo-app"));

    expect(result.plist_source).toBe("expo_config");
    expect(result.plist).not.toBeNull();
    expect(result.plist!.usage_descriptions.NSMicrophoneUsageDescription).toBe(
      "Record voice notes."
    );
    expect(result.plist!.gad_application_identifier).toBeNull();
  });

  it("flutter-app: reads Info.plist under ios/Runner", () => {
    const result = extractIosPlist(fixturePath("flutter-app"));

    expect(result.plist).not.toBeNull();
    expect(result.plist!.usage_descriptions.NSHealthShareUsageDescription).toBe(
      "Read workout data."
    );
  });

  describe("absence behavior", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "rsv2-ios-plist-empty-"));
    // Vitest's afterAll inside a nested describe only runs after this
    // describe's tests, so the temp dir is cleaned up right after use.
    afterAll(() => {
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it("returns plist_source \"none\" and plist null for a project with no plist sources at all", () => {
      const result = extractIosPlist(emptyDir);

      expect(result.plist_source).toBe("none");
      expect(result.plist).toBeNull();
    });

    it("does not crash on an unparsable Info.plist (malformed XML treated as absent source)", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rsv2-ios-plist-malformed-"));
      try {
        writeFileSync(path.join(dir, "Info.plist"), "<not-a-plist>", "utf-8");
        const result = extractIosPlist(dir);
        expect(result.plist_source).toBe("none");
        expect(result.plist).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
