import { describe, it, expect } from "vitest";
import {
  buildDeterministicSummary,
  trimProfileForReport,
  assembleReportV2,
  type AssembleReportInput,
} from "../../src/review/report-builder.js";
import { makeProfile, makeFinding, makeCheck } from "../helpers/review-fixtures.js";
import type { ReviewFinding } from "../../src/types/review.js";

const aiOpts = { aiReviewRan: true, aiAssessment: "Looks fine overall." };

function findingsOf(...levels: ReviewFinding["risk_level"][]): ReviewFinding[] {
  return levels.map((risk_level, i) =>
    makeFinding({ risk_level, title: `${risk_level}-${i}`, id: `f-${i}` })
  );
}

describe("buildDeterministicSummary formula", () => {
  it("applies 85 - 20*high - 5*medium - 1*low over merged findings", () => {
    const summary = buildDeterministicSummary(
      findingsOf("high", "medium", "medium", "low", "low", "low"),
      aiOpts
    );
    expect(summary.estimated_approval_chance).toBe(52); // 85 - 20 - 10 - 3
    expect(summary.total_findings).toBe(6);
    expect(summary.high_risk).toBe(1);
    expect(summary.medium_risk).toBe(2);
    expect(summary.low_risk).toBe(3);
    expect(summary.info).toBe(0);
  });

  it("info findings carry no weight in the formula", () => {
    const summary = buildDeterministicSummary(findingsOf("info", "info", "info"), aiOpts);
    expect(summary.estimated_approval_chance).toBe(85);
    expect(summary.outcome).toBe("likely-approved");
    expect(summary.info).toBe(3);
  });

  it("clamps to the floor of 5", () => {
    const summary = buildDeterministicSummary(
      findingsOf("high", "high", "high", "high", "high"),
      aiOpts
    );
    expect(summary.estimated_approval_chance).toBe(5); // raw would be -15
  });

  it("caps at 85 with no findings (never exceeds the 95 ceiling)", () => {
    const summary = buildDeterministicSummary([], aiOpts);
    expect(summary.estimated_approval_chance).toBe(85);
    expect(summary.estimated_approval_chance).toBeLessThanOrEqual(95);
  });
});

describe("buildDeterministicSummary outcome ladder", () => {
  it("2 high -> likely-rejected", () => {
    expect(buildDeterministicSummary(findingsOf("high", "high"), aiOpts).outcome).toBe(
      "likely-rejected"
    );
  });

  it("1 high -> needs-attention", () => {
    expect(buildDeterministicSummary(findingsOf("high"), aiOpts).outcome).toBe(
      "needs-attention"
    );
  });

  it("3 medium (0 high) -> needs-attention", () => {
    expect(
      buildDeterministicSummary(findingsOf("medium", "medium", "medium"), aiOpts).outcome
    ).toBe("needs-attention");
  });

  it("2 medium (0 high) -> likely-approved", () => {
    expect(buildDeterministicSummary(findingsOf("medium", "medium"), aiOpts).outcome).toBe(
      "likely-approved"
    );
  });

  it("no findings -> likely-approved", () => {
    expect(buildDeterministicSummary([], aiOpts).outcome).toBe("likely-approved");
  });
});

describe("buildDeterministicSummary top risks + assessment", () => {
  it("top_risks holds up to 3 titles of the highest-severity findings", () => {
    const findings = [
      makeFinding({ risk_level: "low", title: "L1" }),
      makeFinding({ risk_level: "high", title: "H1" }),
      makeFinding({ risk_level: "medium", title: "M1" }),
      makeFinding({ risk_level: "medium", title: "M2" }),
      makeFinding({ risk_level: "info", title: "I1" }),
    ];
    expect(buildDeterministicSummary(findings, aiOpts).top_risks).toEqual(["H1", "M1", "M2"]);
  });

  it("keeps the LLM prose as ai_assessment when the AI pass ran", () => {
    const summary = buildDeterministicSummary(findingsOf("high"), aiOpts);
    expect(summary.ai_assessment).toBe("Looks fine overall.");
  });

  it("synthesizes a static-only assessment when the AI pass did not run", () => {
    const summary = buildDeterministicSummary(findingsOf("high", "medium"), {
      aiReviewRan: false,
      checksCount: 24,
    });
    expect(summary.ai_assessment).toBe(
      "Static rule scan found 2 guideline violations across 24 checks. AI behavioral review was not run."
    );
  });

  it("uses singular wording for exactly one violation", () => {
    const summary = buildDeterministicSummary(findingsOf("high"), {
      aiReviewRan: false,
      checksCount: 10,
    });
    expect(summary.ai_assessment).toContain("1 guideline violation across 10 checks");
    expect(summary.ai_assessment).not.toContain("violations");
  });
});

describe("trimProfileForReport", () => {
  it("caps a 51+ entry bucket at 50 (keeping the first 50) and leaves small buckets intact", () => {
    const profile = makeProfile({
      raw_dependencies: {
        npm: Array.from({ length: 51 }, (_, i) => `pkg-${i}`),
        pub: ["single"],
        pods: [],
        spm: [],
        gradle: [],
        nuget: [],
        upm: [],
        ios_imports: [],
        android_imports: [],
      },
    });

    const trimmed = trimProfileForReport(profile);

    expect(trimmed.raw_dependencies.npm).toHaveLength(50);
    expect(trimmed.raw_dependencies.npm[0]).toBe("pkg-0");
    expect(trimmed.raw_dependencies.npm[49]).toBe("pkg-49");
    expect(trimmed.raw_dependencies.pub).toEqual(["single"]);
    // The input profile must not be mutated.
    expect(profile.raw_dependencies.npm).toHaveLength(51);
  });
});

describe("assembleReportV2", () => {
  function baseInput(overrides: Partial<AssembleReportInput> = {}): AssembleReportInput {
    return {
      platform: "iOS Native (Swift/Objective-C)",
      bundleId: "com.test.app",
      sourceFilesAnalyzed: 12,
      featuresDetected: [],
      staticFindings: [
        makeFinding({
          id: "appstore.static-rule",
          rule_id: "appstore.static-rule",
          detection: "static",
          risk_level: "high",
          title: "Static high",
        }),
      ],
      aiFindings: [],
      checks: [makeCheck({ status: "fail" }), makeCheck({ rule_id: "appstore.other", status: "pass" })],
      profile: makeProfile(),
      rulepack: { version: "2.0.2", store: "appstore", source: "bundled" },
      engineVersion: "2.0.0",
      aiReviewRan: false,
      ragStoriesUsed: 0,
      scanDurationMs: 42,
      ...overrides,
    };
  }

  it("fills every v2 field", () => {
    const report = assembleReportV2(baseInput());
    expect(report.report_schema_version).toBe(2);
    expect(report.engine_version).toBe("2.0.0");
    expect(report.rulepack_version).toBe("2.0.2");
    expect(report.rulepack_store).toBe("appstore");
    expect(report.rulepack_source).toBe("bundled");
    expect(report.app_profile).toBeDefined();
    expect(report.checks).toHaveLength(2);
  });

  it("static-only path: ai_review_ran false, findings are static only, rag 0", () => {
    const report = assembleReportV2(baseInput());
    expect(report.ai_review_ran).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].detection).toBe("static");
    expect(report.rag_stories_used).toBe(0);
    expect(report.features_detected).toEqual([]);
    expect(report.summary.ai_assessment).toContain("AI behavioral review was not run");
  });

  it("hybrid path: merges static-then-AI findings, summary computed over the merge", () => {
    const report = assembleReportV2(
      baseInput({
        aiFindings: [
          makeFinding({ id: "ai-1", detection: "ai", risk_level: "high", title: "AI high" }),
        ],
        aiReviewRan: true,
        aiAssessment: "Model prose.",
        ragStoriesUsed: 15,
      })
    );
    expect(report.ai_review_ran).toBe(true);
    expect(report.findings.map((f) => f.detection)).toEqual(["static", "ai"]);
    // 2 high across static + AI -> likely-rejected, 85 - 40 = 45
    expect(report.summary.high_risk).toBe(2);
    expect(report.summary.outcome).toBe("likely-rejected");
    expect(report.summary.estimated_approval_chance).toBe(45);
    expect(report.summary.ai_assessment).toBe("Model prose.");
    expect(report.rag_stories_used).toBe(15);
  });

  it("trims the embedded profile's raw_dependencies buckets to 50", () => {
    const report = assembleReportV2(
      baseInput({
        profile: makeProfile({
          raw_dependencies: {
            npm: Array.from({ length: 80 }, (_, i) => `dep-${i}`),
            pub: [],
            pods: [],
            spm: [],
            gradle: [],
            nuget: [],
            upm: [],
            ios_imports: [],
            android_imports: [],
          },
        }),
      })
    );
    expect(report.app_profile?.raw_dependencies.npm).toHaveLength(50);
  });
});
