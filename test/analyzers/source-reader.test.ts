import { describe, it, expect } from "vitest";
import { readSourceCode } from "../../src/analyzers/source-reader.js";
import { fixturePath } from "../helpers/fixture-path.js";

// Task 4 (rsv2-task-4-brief.md): the "swift" stack's source-file extensions
// now include .m/.mm/.h alongside .swift, so an ObjC-only project's source
// actually reaches the AI-context dump (readSourceCode), not just the
// dependency-import scanner (see test/engine/collect-deps.test.ts).
describe("readSourceCode - ObjC reach", () => {
  it("objc-app (stack swift): AppDelegate.m content is included in the source dump", () => {
    const dump = readSourceCode(fixturePath("objc-app"), "swift");

    expect(dump).toContain("AppDelegate.m");
    expect(dump).toContain("createAccount");
  });

  it("swift-app (stack swift, no .m/.mm files): behavior unchanged - only .swift files appear", () => {
    const dump = readSourceCode(fixturePath("swift-app"), "swift");

    expect(dump).toContain("AppDelegate.swift");
    expect(dump).toContain("ContentView.swift");
  });

  it("unity-app (stack unity): .cs source is included", () => {
    const dump = readSourceCode(fixturePath("unity-app"), "unity");

    expect(dump).toContain("GameController.cs");
    expect(dump).toContain("UnityEngine");
  });

  it("kmp-app (stack kmp): both .kt and .swift source are included", () => {
    const dump = readSourceCode(fixturePath("kmp-app"), "kmp");

    expect(dump).toContain("App.kt");
    expect(dump).toContain("ContentView.swift");
  });
});
