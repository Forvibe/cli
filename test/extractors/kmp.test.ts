import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { findKmpLayout } from "../../src/engine/extractors/kmp.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("findKmpLayout", () => {
  it("kmp-app: layout found - all three fields non-null", () => {
    const layout = findKmpLayout(fixturePath("kmp-app"));

    expect(layout.iosAppDir).not.toBeNull();
    expect(layout.androidModuleDir).not.toBeNull();
    expect(layout.sharedDir).not.toBeNull();
  });

  it("kmp-app: iosAppDir points at iosApp/, androidModuleDir at androidApp/, sharedDir at shared/", () => {
    const layout = findKmpLayout(fixturePath("kmp-app"));

    expect(layout.iosAppDir).toBe(join(fixturePath("kmp-app"), "iosApp"));
    expect(layout.androidModuleDir).toBe(join(fixturePath("kmp-app"), "androidApp"));
    expect(layout.sharedDir).toBe(join(fixturePath("kmp-app"), "shared"));
  });

  it("kotlin-app: sharedDir is null (no module declares the Kotlin Multiplatform plugin)", () => {
    const layout = findKmpLayout(fixturePath("kotlin-app"));

    expect(layout.sharedDir).toBeNull();
  });

  it("kotlin-app: iosAppDir is null (no iosApp/ directory at all)", () => {
    const layout = findKmpLayout(fixturePath("kotlin-app"));

    expect(layout.iosAppDir).toBeNull();
  });
});
