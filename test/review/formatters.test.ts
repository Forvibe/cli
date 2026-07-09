import { describe, it, expect } from "vitest";
import chalk from "chalk";
import { formatTerminal, formatMarkdown, formatJSON } from "../../src/review/formatters.js";
import { makeProfile, makeFinding, makeCheck } from "../helpers/review-fixtures.js";
import type { CodeReviewReport } from "../../src/types/review.js";

// Force plain output: the formatter module shares this chalk singleton.
chalk.level = 0;

// Belt and suspenders: strip any ANSI sequences that slip through anyway
// (e.g. FORCE_COLOR set in the environment), so assertions stay stable.
function strip(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}

/** Handcrafted ReportV2: checks in all 4 statuses, one static + one AI finding. */
function makeV2Report(overrides: Partial<CodeReviewReport> = {}): CodeReviewReport {
  return {
    features_detected: [],
    source_files_analyzed: 12,
    platform: "iOS Native (Swift/Objective-C)",
    bundle_id: "com.test.app",
    findings: [
      makeFinding({
        id: "appstore.att-missing",
        rule_id: "appstore.att-missing",
        detection: "static",
        risk_level: "high",
        title: "Tracking permission text missing",
        guideline_number: "5.1.2",
        guideline_name: "Data Use and Sharing",
      }),
      makeFinding({
        id: "ugc-no-moderation",
        detection: "ai",
        risk_level: "medium",
        title: "UGC without moderation tools",
        guideline_number: "1.2",
        guideline_name: "User-Generated Content",
      }),
    ],
    summary: {
      total_findings: 2,
      high_risk: 1,
      medium_risk: 1,
      low_risk: 0,
      info: 0,
      outcome: "needs-attention",
      estimated_approval_chance: 60,
      top_risks: ["Tracking permission text missing"],
      ai_assessment: "Static rule scan found 1 guideline violation across 4 checks. AI behavioral review was not run.",
    },
    rag_stories_used: 0,
    scan_duration_ms: 1234,
    report_schema_version: 2,
    engine_version: "2.0.0",
    rulepack_version: "2.0.2",
    rulepack_store: "appstore",
    rulepack_source: "bundled",
    app_profile: makeProfile(),
    checks: [
      makeCheck({
        rule_id: "appstore.att-missing",
        status: "fail",
        guideline_number: "5.1.2",
        title: "Tracking permission text missing",
      }),
      makeCheck({
        rule_id: "appstore.iap-flow",
        status: "unverified",
        guideline_number: "3.1.1",
        title: "In-app purchase flow needs manual verification",
      }),
      makeCheck({ rule_id: "appstore.ats", status: "pass", title: "ATS configured" }),
      makeCheck({ rule_id: "appstore.health", status: "na", title: "HealthKit rules" }),
    ],
    ai_review_ran: false,
    ...overrides,
  };
}

/** v1-shaped report: none of the v2 optional fields. */
function makeV1Report(): CodeReviewReport {
  return {
    features_detected: ["subscriptions"],
    source_files_analyzed: 8,
    platform: "Flutter",
    bundle_id: "com.legacy.app",
    findings: [makeFinding({ title: "Legacy finding" })],
    summary: {
      total_findings: 1,
      high_risk: 0,
      medium_risk: 1,
      low_risk: 0,
      info: 0,
      outcome: "needs-attention",
      estimated_approval_chance: 70,
      top_risks: ["Legacy finding"],
      ai_assessment: "Legacy assessment.",
    },
    rag_stories_used: 15,
    scan_duration_ms: 900,
  };
}

describe("formatTerminal v2", () => {
  const output = strip(formatTerminal(makeV2Report()));

  it("renders the compliance checks section with all four counts", () => {
    expect(output).toContain("COMPLIANCE CHECKS");
    expect(output).toContain("1 failed, 1 verify manually, 1 passed, 1 not applicable");
  });

  it("lists failed checks with guideline + title", () => {
    expect(output).toContain("✗ [5.1.2] Tracking permission text missing");
  });

  it("lists unverified checks with the VERIFY prefix", () => {
    expect(output).toContain("VERIFY: [3.1.1] In-app purchase flow needs manual verification");
  });

  it("collapses passed checks into a single line and omits n/a", () => {
    expect(output).toContain("1 check passed (run with --format json for the full list)");
    expect(output).not.toContain("HealthKit rules");
  });

  it("prepends detection badges to findings", () => {
    expect(output).toContain("[static] Tracking permission text missing");
    expect(output).toContain("[AI] UGC without moderation tools");
  });

  it("renders the rulepack + engine footer", () => {
    expect(output).toContain("Rulepack v2.0.2 (bundled) · Engine v2.0.0");
  });

  it("shows the static-only banner when ai_review_ran is false", () => {
    expect(output).toContain("AI behavioral review skipped. Static rule results only.");
  });

  it("hides the static-only banner when the AI pass ran", () => {
    const hybrid = strip(formatTerminal(makeV2Report({ ai_review_ran: true })));
    expect(hybrid).not.toContain("AI behavioral review skipped.");
  });
});

describe("formatTerminal v1 compatibility", () => {
  const output = strip(formatTerminal(makeV1Report()));

  it("renders a v1-shaped report without crashing", () => {
    expect(output).toContain("Legacy finding");
    expect(output).toContain("Flutter");
  });

  it("omits the v2-only sections", () => {
    expect(output).not.toContain("COMPLIANCE CHECKS");
    expect(output).not.toContain("Rulepack v");
    expect(output).not.toContain("AI behavioral review skipped.");
    // No detection on v1 findings -> no badges
    expect(output).not.toContain("[static]");
    expect(output).not.toContain("[AI]");
  });
});

describe("formatMarkdown v2", () => {
  const output = formatMarkdown(makeV2Report());

  it("mirrors the compliance checks section", () => {
    expect(output).toContain("## Compliance Checks");
    expect(output).toContain("1 failed, 1 verify manually, 1 passed, 1 not applicable");
    expect(output).toContain("- FAILED: [5.1.2] Tracking permission text missing");
    expect(output).toContain("- VERIFY: [3.1.1] In-app purchase flow needs manual verification");
  });

  it("prepends detection badges to finding headings", () => {
    expect(output).toContain("[static] Tracking permission text missing");
    expect(output).toContain("[AI] UGC without moderation tools");
  });

  it("renders footer + static-only banner", () => {
    expect(output).toContain("Rulepack v2.0.2 (bundled) · Engine v2.0.0");
    expect(output).toContain("AI behavioral review skipped. Static rule results only.");
  });

  it("renders a v1-shaped report without the v2 sections", () => {
    const legacy = formatMarkdown(makeV1Report());
    expect(legacy).toContain("Legacy finding");
    expect(legacy).not.toContain("## Compliance Checks");
    expect(legacy).not.toContain("Rulepack v");
  });
});

describe("formatJSON", () => {
  it("round-trips the full v2 report", () => {
    const report = makeV2Report();
    const parsed = JSON.parse(formatJSON(report)) as CodeReviewReport;
    expect(parsed.report_schema_version).toBe(2);
    expect(parsed.checks).toHaveLength(4);
    expect(parsed.app_profile?.app.bundle_id).toBe("com.test.app");
  });
});
