import { describe, it, expect } from "vitest";
import { scanSDKs } from "../../src/analyzers/sdk-scanner.js";
import { fixturePath } from "../helpers/fixture-path.js";

// Behavior-preservation lock for scanSDKs(): Task 3b adds collectRawDependencies()
// to this file as an ADDITIVE export, but scanSDKs()/getDependencies() (the
// `analyze` command's dependency) must keep their EXACT current observable
// behavior. This snapshot was captured from the pre-refactor code path (before
// any Task 3b edits touched this file) - see the task report for how. If a
// later change to sdk-scanner.ts alters scanSDKs' output for these fixtures,
// this test fails and the snapshot must NOT be blindly regenerated; that would
// silently bless a behavior change the brief explicitly forbids.
describe("scanSDKs compat snapshot (pre-refactor lock)", () => {
  it("swift-app: detected SDKs unchanged", () => {
    expect(scanSDKs(fixturePath("swift-app"), "swift")).toMatchSnapshot();
  });

  it("flutter-app: detected SDKs unchanged", () => {
    expect(scanSDKs(fixturePath("flutter-app"), "flutter")).toMatchSnapshot();
  });

  it("kotlin-app: detected SDKs unchanged", () => {
    expect(scanSDKs(fixturePath("kotlin-app"), "kotlin")).toMatchSnapshot();
  });
});
