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
    // Omitted-vs-null contract: these source keys are genuinely absent from
    // the fixture plist, so the properties must be OMITTED (definitive
    // absence), not present-with-null.
    expect("non_exempt_encryption" in plist).toBe(false);
    expect("gad_application_identifier" in plist).toBe(false);
    expect(plist.background_modes).toEqual(["audio"]);
    expect(plist.required_device_capabilities).toEqual(["arm64"]);
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
  });

  it("swift-modern-app: pbxproj INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO maps to false (regression: Boolean(\"NO\") inversion)", () => {
    const result = extractIosPlist(fixturePath("swift-modern-app"));

    expect(result.plist!.non_exempt_encryption).toBe(false);
  });

  describe("pbxproj boolean-string normalization", () => {
    // Minimal generated-Info.plist project: only a pbxproj, no Info.plist
    // file, so the string-valued INFOPLIST_KEY_* path is the ONLY source.
    function writePbxprojOnlyProject(dir: string, encryptionValue: string): void {
      writeFileSync(
        path.join(dir, "project.pbxproj"),
        `// !$*UTF8*$!
{
	objects = {
		D1000021 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = ${encryptionValue};
				PRODUCT_BUNDLE_IDENTIFIER = com.forvibe.fixture.synthetic;
			};
			name = Release;
		};
	};
}
`,
        "utf-8"
      );
    }

    it("INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = YES maps to true", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rsv2-ios-plist-encryption-yes-"));
      try {
        writePbxprojOnlyProject(dir, "YES");
        const result = extractIosPlist(dir);
        expect(result.plist_source).toBe("pbxproj_infoplist_keys");
        expect(result.plist!.non_exempt_encryption).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a $(VAR) value keeps the property PRESENT with null (present but unresolvable)", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rsv2-ios-plist-encryption-junk-"));
      try {
        writePbxprojOnlyProject(dir, '"$(SOME_FLAG)"');
        const result = extractIosPlist(dir);
        // The source key exists -> property present; unparseable -> null,
        // never a guessed boolean.
        expect("non_exempt_encryption" in result.plist!).toBe(true);
        expect(result.plist!.non_exempt_encryption).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("a $(VAR)-valued GADApplicationIdentifier is PRESENT with null (unresolved build variable)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rsv2-ios-plist-gad-var-"));
    try {
      writeFileSync(
        path.join(dir, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>GADApplicationIdentifier</key>
	<string>$(GAD_APP_ID)</string>
</dict>
</plist>
`,
        "utf-8"
      );
      const result = extractIosPlist(dir);
      expect("gad_application_identifier" in result.plist!).toBe(true);
      expect(result.plist!.gad_application_identifier).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expo-app: derives plist from app.json expo.ios.infoPlist", () => {
    const result = extractIosPlist(fixturePath("expo-app"));

    expect(result.plist_source).toBe("expo_config");
    expect(result.plist).not.toBeNull();
    expect(result.plist!.usage_descriptions.NSMicrophoneUsageDescription).toBe(
      "Record voice notes."
    );
    // No GADApplicationIdentifier in the expo config -> property omitted.
    expect("gad_application_identifier" in result.plist!).toBe(false);
  });

  it("flutter-app: reads Info.plist under ios/Runner", () => {
    const result = extractIosPlist(fixturePath("flutter-app"));

    expect(result.plist).not.toBeNull();
    expect(result.plist!.usage_descriptions.NSHealthShareUsageDescription).toBe(
      "Read workout data."
    );
  });

  describe("expo alternate GAD app-id sources (app.json outside infoPlist)", () => {
    // Synthetic app.json temp-dir cases (the committed expo-app fixture's
    // planted facts stay untouched). All cases include an expo.ios.infoPlist
    // block: the alternate-source lookup is deliberately gated on it (see
    // extractor comment).
    function writeAppJson(dir: string, appJson: unknown): void {
      writeFileSync(path.join(dir, "app.json"), JSON.stringify(appJson, null, 2), "utf-8");
    }

    function extractFromAppJson(name: string, appJson: unknown) {
      const dir = mkdtempSync(path.join(tmpdir(), `rsv2-ios-plist-gad-${name}-`));
      try {
        writeAppJson(dir, appJson);
        return extractIosPlist(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const infoPlistBlock = { NSCameraUsageDescription: "Scan things." };

    it("reads the classic expo.ios.config.googleMobileAdsAppId location", () => {
      const result = extractFromAppJson("legacy-config", {
        expo: {
          ios: {
            infoPlist: infoPlistBlock,
            config: { googleMobileAdsAppId: "ca-app-pub-111~111" },
          },
        },
      });
      expect(result.plist!.gad_application_identifier).toBe("ca-app-pub-111~111");
    });

    it("reads the top-level react-native-google-mobile-ads block (snake_case ios_app_id)", () => {
      const result = extractFromAppJson("rn-top-level", {
        expo: { ios: { infoPlist: infoPlistBlock } },
        "react-native-google-mobile-ads": { ios_app_id: "ca-app-pub-222~222" },
      });
      expect(result.plist!.gad_application_identifier).toBe("ca-app-pub-222~222");
    });

    it("reads the expo.plugins config-plugin entry (camelCase iosAppId)", () => {
      const result = extractFromAppJson("plugin-camel", {
        expo: {
          ios: { infoPlist: infoPlistBlock },
          plugins: [
            "expo-camera",
            ["react-native-google-mobile-ads", { iosAppId: "ca-app-pub-333~333" }],
          ],
        },
      });
      expect(result.plist!.gad_application_identifier).toBe("ca-app-pub-333~333");
    });

    it("accepts the legacy snake_case ios_app_id spelling in the plugin entry", () => {
      const result = extractFromAppJson("plugin-snake", {
        expo: {
          ios: { infoPlist: infoPlistBlock },
          plugins: [["react-native-google-mobile-ads", { ios_app_id: "ca-app-pub-444~444" }]],
        },
      });
      expect(result.plist!.gad_application_identifier).toBe("ca-app-pub-444~444");
    });

    it("an explicit infoPlist.GADApplicationIdentifier wins over the config locations", () => {
      const result = extractFromAppJson("infoplist-wins", {
        expo: {
          ios: {
            infoPlist: { ...infoPlistBlock, GADApplicationIdentifier: "ca-app-pub-999~999" },
            config: { googleMobileAdsAppId: "ca-app-pub-111~111" },
          },
        },
      });
      expect(result.plist!.gad_application_identifier).toBe("ca-app-pub-999~999");
    });

    it("no GAD source anywhere + infoPlist block present -> property omitted (MISSING preserved)", () => {
      const result = extractFromAppJson("none", {
        expo: { ios: { infoPlist: infoPlistBlock } },
      });
      expect(result.plist).not.toBeNull();
      expect("gad_application_identifier" in result.plist!).toBe(false);
    });
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
