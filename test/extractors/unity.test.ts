import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractUnityProjectSettings } from "../../src/engine/extractors/unity.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("extractUnityProjectSettings", () => {
  it("unity-app: parses ProjectSettings.asset -> bundle ids, version, product name", () => {
    const result = extractUnityProjectSettings(fixturePath("unity-app"));

    expect(result).not.toBeNull();
    expect(result?.bundle_ids).toEqual({
      ios: "com.forvibe.fixture.unity",
      android: "com.forvibe.fixture.unity",
    });
    expect(result?.bundle_id).toBe("com.forvibe.fixture.unity");
    expect(result?.app_version).toBe("0.3.0");
    expect(result?.product_name).toBe("FixtureUnity");
  });

  it("unity-app: evidence points at ProjectSettings/ProjectSettings.asset", () => {
    const result = extractUnityProjectSettings(fixturePath("unity-app"));

    expect(result?.evidence["unity.project_settings"]?.file).toBe(
      path.join("ProjectSettings", "ProjectSettings.asset")
    );
  });

  it("malformed asset (unterminated quoted scalar): yaml.parse throws, regex fallback still yields applicationIdentifier", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rsv2-unity-malformed-"));
    try {
      mkdirSync(path.join(dir, "ProjectSettings"), { recursive: true });
      writeFileSync(
        path.join(dir, "ProjectSettings", "ProjectSettings.asset"),
        [
          "%YAML 1.1",
          "%TAG !u! tag:unity3d.com,2011:",
          "--- !u!129 &1",
          "PlayerSettings:",
          '  productName: "Unterminated',
          "  applicationIdentifier:",
          "    Android: com.forvibe.fixture.malformed",
          "    iPhone: com.forvibe.fixture.malformed",
          "  bundleVersion: 9.9.9",
          "",
        ].join("\n")
      );

      const result = extractUnityProjectSettings(dir);

      expect(result).not.toBeNull();
      expect(result?.bundle_ids.ios).toBe("com.forvibe.fixture.malformed");
      expect(result?.bundle_ids.android).toBe("com.forvibe.fixture.malformed");
      expect(result?.bundle_id).toBe("com.forvibe.fixture.malformed");
      // Fallback contract only covers bundle ids - version/productName are
      // not recovered from the regex path.
      expect(result?.app_version).toBeNull();
      expect(result?.product_name).toBeNull();
      expect(result?.evidence["unity.project_settings"]?.detail).toContain("regex fallback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing ProjectSettings/ProjectSettings.asset -> null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rsv2-unity-missing-"));
    try {
      const result = extractUnityProjectSettings(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws even on a non-Unity directory", () => {
    expect(() => extractUnityProjectSettings(fixturePath("swift-app"))).not.toThrow();
    expect(extractUnityProjectSettings(fixturePath("swift-app"))).toBeNull();
  });
});
