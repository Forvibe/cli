import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractAndroidManifest } from "../../src/engine/extractors/android-manifest.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("extractAndroidManifest", () => {
  it("kotlin-app: finds app/src/main/AndroidManifest.xml and reads permissions/exported/queries", () => {
    const { android } = extractAndroidManifest(fixturePath("kotlin-app"));

    expect(android.manifest_found).toBe(true);
    expect(android.permissions).toContain("android.permission.INTERNET");
    expect(android.permissions).toContain("android.permission.ACCESS_FINE_LOCATION");
    expect(android.permissions).toContain("android.permission.CAMERA");
    expect(android.exported_components).toBe(1);
    expect(android.queries_declared).toBe(true);
  });

  it("flutter-app: finds android/app/src/main/AndroidManifest.xml", () => {
    const { android } = extractAndroidManifest(fixturePath("flutter-app"));

    expect(android.manifest_found).toBe(true);
    expect(android.permissions).toContain("android.permission.INTERNET");
    expect(android.permissions).toContain("android.permission.ACTIVITY_RECOGNITION");
  });

  it("permissions are deduped and sorted", () => {
    const { android } = extractAndroidManifest(fixturePath("kotlin-app"));
    const sorted = [...android.permissions].sort();
    expect(android.permissions).toEqual(sorted);
    expect(new Set(android.permissions).size).toBe(android.permissions.length);
  });

  it("returns manifest_found false and empty defaults when no AndroidManifest.xml exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rsv2-android-manifest-empty-"));
    try {
      const { android } = extractAndroidManifest(dir);
      expect(android).toEqual({
        manifest_found: false,
        permissions: [],
        exported_components: 0,
        queries_declared: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
