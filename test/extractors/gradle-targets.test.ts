import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractGradleTargets } from "../../src/engine/extractors/gradle-targets.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("extractGradleTargets", () => {
  it("kotlin-app: reads min/target/compile SDK from the Groovy app module (space syntax)", () => {
    const result = extractGradleTargets(fixturePath("kotlin-app"));

    expect(result.min_android_sdk).toBe(24);
    expect(result.target_android_sdk).toBe(34);
    expect(result.compile_sdk).toBe(34);
  });

  it("flutter-app: reads min/target SDK from android/app/build.gradle (...Version syntax)", () => {
    const result = extractGradleTargets(fixturePath("flutter-app"));

    expect(result.min_android_sdk).toBe(23);
    expect(result.target_android_sdk).toBe(34);
  });

  describe("synthetic gradle syntax variants", () => {
    let dir: string;

    it("handles KTS assignment syntax (targetSdk = 34)", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-gradle-kts-"));
      try {
        writeFileSync(
          path.join(dir, "build.gradle.kts"),
          `android {
    compileSdk = 35
    defaultConfig {
        minSdk = 26
        targetSdk = 35
    }
}
`,
          "utf-8"
        );
        const result = extractGradleTargets(dir);
        expect(result.min_android_sdk).toBe(26);
        expect(result.target_android_sdk).toBe(35);
        expect(result.compile_sdk).toBe(35);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("treats an unresolvable flutter.targetSdkVersion indirection as null", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-gradle-indirection-"));
      try {
        writeFileSync(
          path.join(dir, "build.gradle"),
          `android {
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
        targetSdkVersion flutter.targetSdkVersion
    }
}
`,
          "utf-8"
        );
        const result = extractGradleTargets(dir);
        expect(result.target_android_sdk).toBeNull();
        expect(result.min_android_sdk).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns all-null when no gradle file is found", () => {
      dir = mkdtempSync(path.join(tmpdir(), "rsv2-gradle-empty-"));
      try {
        const result = extractGradleTargets(dir);
        expect(result.target_android_sdk).toBeNull();
        expect(result.min_android_sdk).toBeNull();
        expect(result.compile_sdk).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
