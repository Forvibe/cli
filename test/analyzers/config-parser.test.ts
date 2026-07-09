import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/analyzers/config-parser.js";
import { fixturePath } from "../helpers/fixture-path.js";

// Task 4 (rsv2-task-4-brief.md) additive cases: unity, kmp. Existing cases
// (flutter/expo/react-native/swift/kotlin/capacitor/dotnet-maui) are
// untouched and remain covered indirectly via test/engine/static-engine.test.ts.
describe("parseConfig - unity", () => {
  it("unity-app: app_name/bundle_id/version parsed from ProjectSettings.asset", () => {
    const config = parseConfig(fixturePath("unity-app"), "unity");

    expect(config.app_name).toBe("FixtureUnity");
    expect(config.bundle_id).toBe("com.forvibe.fixture.unity");
    expect(config.version).toBe("0.3.0");
  });

  it("a directory with no ProjectSettings.asset returns the empty config, not a throw", () => {
    expect(() => parseConfig(fixturePath("kotlin-app"), "unity")).not.toThrow();
    const config = parseConfig(fixturePath("kotlin-app"), "unity");
    expect(config.bundle_id).toBeNull();
    expect(config.app_name).toBeNull();
  });
});

describe("parseConfig - kmp", () => {
  it("kmp-app: bundle_id from androidApp/build.gradle.kts, min_android_sdk from the same file", () => {
    const config = parseConfig(fixturePath("kmp-app"), "kmp");

    expect(config.bundle_id).toBe("com.forvibe.fixture.kmp");
    expect(config.min_android_sdk).toBe("24");
  });

  it("kmp-app: app_name from iosApp/iosApp/Info.plist CFBundleDisplayName", () => {
    const config = parseConfig(fixturePath("kmp-app"), "kmp");

    expect(config.app_name).toBe("FixtureKmp");
  });
});
