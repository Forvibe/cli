import { describe, it, expect } from "vitest";
import {
  readSourceCode,
  sortByPriority,
  getPriorityPatternsForStack,
} from "../../src/analyzers/source-reader.js";
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

describe("sortByPriority", () => {
  const flutter = getPriorityPatternsForStack("flutter");

  it("ranks the basename over directory names", () => {
    // The old scorer counted pattern hits anywhere in the path, so every file
    // under lib/features/home/widget/ scored 2 (for the directories "home" and
    // "widget") while lib/main.dart scored 1. One feature folder outranked the
    // entry point and ate the entire budget.
    const sorted = sortByPriority(
      [
        "lib/features/home/widget/menu_card.dart",
        "lib/features/home/widget/home_ask_bar.dart",
        "lib/main.dart",
      ],
      flutter
    );

    expect(sorted[0]).toBe("lib/main.dart");
  });

  it("surfaces Flutter view files that previously scored zero", () => {
    // "view" was in the swift pattern list but missing from flutter's, so
    // settings_view.dart scored 0 and was never read, despite holding the
    // account-deletion, privacy-policy and restore-purchases flows.
    const sorted = sortByPriority(
      [
        "lib/features/home/widget/card_a.dart",
        "lib/features/home/widget/card_b.dart",
        "lib/features/home/widget/card_c.dart",
        "lib/features/home/widget/card_d.dart",
        "lib/features/home/widget/card_e.dart",
        "lib/features/settings/view/settings_view.dart",
      ],
      flutter
    );

    expect(sorted.indexOf("lib/features/settings/view/settings_view.dart")).toBeLessThan(5);
  });

  it("caps how many files a single directory contributes up front", () => {
    const files = Array.from({ length: 8 }, (_, i) => `lib/features/home/widget/w${i}_widget.dart`);
    files.push("lib/core/services/api_service.dart");

    const sorted = sortByPriority(files, flutter);
    const firstFive = sorted.slice(0, 5);
    const fromWidgetDir = firstFive.filter((f) => f.includes("home/widget")).length;

    expect(fromWidgetDir).toBeLessThanOrEqual(4);
    expect(sorted).toHaveLength(files.length); // nothing is dropped, only reordered
  });

  it("is a stable total ordering (same input, same output)", () => {
    const files = ["b/x.dart", "a/y.dart", "a/z.dart"];
    expect(sortByPriority(files, flutter)).toEqual(sortByPriority(files, flutter));
  });
});
