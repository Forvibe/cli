import { describe, it, expect } from "vitest";
import { detectTechStack } from "../../src/analyzers/tech-detector.js";
import { fixturePath } from "../helpers/fixture-path.js";

// Detection matrix: every committed fixture -> its exact expected stack.
// Task 4 (rsv2-task-4-brief.md) inserts unity/kmp rules between swift and
// kotlin; this locks in that the five pre-existing fixtures still detect
// identically, and that the three new fixtures land on the right stack.
describe("detectTechStack matrix", () => {
  it("flutter-app -> flutter", () => {
    expect(detectTechStack(fixturePath("flutter-app")).stack).toBe("flutter");
  });

  it("expo-app -> expo", () => {
    expect(detectTechStack(fixturePath("expo-app")).stack).toBe("expo");
  });

  it("swift-app -> swift, relabeled 'iOS Native (Swift/Objective-C)'", () => {
    const result = detectTechStack(fixturePath("swift-app"));
    expect(result.stack).toBe("swift");
    expect(result.label).toBe("iOS Native (Swift/Objective-C)");
  });

  it("swift-modern-app -> swift", () => {
    expect(detectTechStack(fixturePath("swift-modern-app")).stack).toBe("swift");
  });

  it("kotlin-app -> kotlin, NOT kmp", () => {
    const result = detectTechStack(fixturePath("kotlin-app"));
    expect(result.stack).toBe("kotlin");
    expect(result.stack).not.toBe("kmp");
  });

  it("unity-app -> unity", () => {
    const result = detectTechStack(fixturePath("unity-app"));
    expect(result.stack).toBe("unity");
    expect(result.label).toBe("Unity");
    expect(result.platforms).toEqual(["ios", "android"]);
  });

  it("unity-app does NOT match kotlin (no root gradle file at all)", () => {
    expect(detectTechStack(fixturePath("unity-app")).stack).not.toBe("kotlin");
  });

  it("kmp-app -> kmp", () => {
    const result = detectTechStack(fixturePath("kmp-app"));
    expect(result.stack).toBe("kmp");
    expect(result.label).toBe("Kotlin Multiplatform");
    expect(result.platforms).toEqual(["ios", "android"]);
  });

  it("kmp-app does NOT match kotlin (rule order + module-name mismatch: androidApp/, not app/)", () => {
    expect(detectTechStack(fixturePath("kmp-app")).stack).not.toBe("kotlin");
  });

  it("objc-app -> swift, with the new label (ObjC-only project, no .swift files anywhere)", () => {
    const result = detectTechStack(fixturePath("objc-app"));
    expect(result.stack).toBe("swift");
    expect(result.label).toBe("iOS Native (Swift/Objective-C)");
    expect(result.platforms).toEqual(["ios"]);
  });
});
