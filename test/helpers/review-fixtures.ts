// Hand-rolled factories for review-pipeline unit tests (report-builder,
// formatters, reviewer helpers). Minimal-but-valid shapes with per-test
// overrides; no I/O, no network.

import type { AppProfile, ReviewCheck } from "../../src/engine/types.js";
import type { ReviewFinding } from "../../src/types/review.js";

export function makeProfile(overrides: Partial<AppProfile> = {}): AppProfile {
  return {
    schema_version: 1,
    generated_at: "2026-07-09T00:00:00.000Z",
    stack: "swift",
    stack_label: "iOS Native (Swift/Objective-C)",
    platforms: ["ios"],
    app: {
      name: "TestApp",
      bundle_id: "com.test.app",
      version: "1.0.0",
      min_ios_version: "15.0",
      min_android_sdk: null,
      target_android_sdk: null,
    },
    sdks: [],
    raw_dependencies: {
      npm: [],
      pub: [],
      pods: [],
      spm: [],
      gradle: [],
      nuget: [],
      upm: [],
      ios_imports: [],
      android_imports: [],
    },
    ios: null,
    android: null,
    capabilities: [],
    signals: {
      restore_purchases_found: null,
      account_deletion_found: null,
      privacy_policy_link_found: null,
      external_checkout_url_found: null,
      webview_ratio: null,
    },
    evidence: {},
    stats: { files_scanned: 0, source_chars_read: 0 },
    ...overrides,
  };
}

export function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "test-finding",
    title: "Test Finding",
    risk_level: "medium",
    category: "safety",
    source: "codebase",
    guideline_number: "5.1.1",
    guideline_name: "Data Collection and Storage",
    description: "Test description",
    user_impact: "Test impact",
    evidence: "",
    recommendation: "Test fix",
    ...overrides,
  };
}

export function makeCheck(overrides: Partial<ReviewCheck> = {}): ReviewCheck {
  return {
    rule_id: "appstore.test-rule",
    title: "Test rule",
    status: "pass",
    severity: "medium",
    guideline_number: "5.1.1",
    ...overrides,
  };
}
