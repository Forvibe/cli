import { describe, it, expect } from "vitest";
import { dedupeAIFindings, mapFeaturesToCapabilities } from "../../src/review/reviewer.js";
import { makeFinding } from "../helpers/review-fixtures.js";
import type { AppFeatureAnalysis } from "../../src/types/review.js";

describe("dedupeAIFindings", () => {
  const staticFindings = [
    makeFinding({
      id: "appstore.att-usage-description-missing",
      rule_id: "appstore.att-usage-description-missing",
      detection: "static",
      guideline_number: "5.1.2",
      title: "Missing App Tracking Transparency usage description",
    }),
  ];

  it("drops an AI finding with matching guideline and identical title", () => {
    const ai = [
      makeFinding({
        detection: "ai",
        guideline_number: "5.1.2",
        title: "Missing App Tracking Transparency usage description",
      }),
    ];
    const { kept, droppedCount } = dedupeAIFindings(ai, staticFindings);
    expect(kept).toHaveLength(0);
    expect(droppedCount).toBe(1);
  });

  it("drops a near-duplicate: normalized title is a substring either way", () => {
    const ai = [
      makeFinding({
        detection: "ai",
        guideline_number: "5.1.2",
        // Different casing/punctuation, contained in the static title
        title: "App Tracking Transparency usage description",
      }),
    ];
    expect(dedupeAIFindings(ai, staticFindings).droppedCount).toBe(1);
  });

  it("keeps an AI finding on the same guideline with an unrelated title", () => {
    const ai = [
      makeFinding({
        detection: "ai",
        guideline_number: "5.1.2",
        title: "Tracking starts before the ATT prompt is shown",
      }),
    ];
    const { kept, droppedCount } = dedupeAIFindings(ai, staticFindings);
    expect(kept).toHaveLength(1);
    expect(droppedCount).toBe(0);
  });

  it("keeps an AI finding with a near-duplicate title on a different guideline", () => {
    const ai = [
      makeFinding({
        detection: "ai",
        guideline_number: "2.1",
        title: "Missing App Tracking Transparency usage description",
      }),
    ];
    expect(dedupeAIFindings(ai, staticFindings).droppedCount).toBe(0);
  });

  it("never lets an empty title substring-match everything", () => {
    const ai = [
      makeFinding({ detection: "ai", guideline_number: "5.1.2", title: "!!!" }),
    ];
    expect(dedupeAIFindings(ai, staticFindings).droppedCount).toBe(0);
  });

  it("counts multiple drops", () => {
    const ai = [
      makeFinding({ id: "a", detection: "ai", guideline_number: "5.1.2", title: "missing app tracking transparency usage description!" }),
      makeFinding({ id: "b", detection: "ai", guideline_number: "5.1.2", title: "ATT prompt fires too early" }),
      makeFinding({ id: "c", detection: "ai", guideline_number: "5.1.2", title: "App Tracking Transparency usage description" }),
    ];
    const { kept, droppedCount } = dedupeAIFindings(ai, staticFindings);
    expect(droppedCount).toBe(2);
    expect(kept.map((f) => f.id)).toEqual(["b"]);
  });
});

describe("mapFeaturesToCapabilities", () => {
  function makeAnalysis(
    features: string[],
    appType: AppFeatureAnalysis["appType"] = "native"
  ): AppFeatureAnalysis {
    return {
      appPurpose: "test app",
      features: features.map((feature) => ({
        feature,
        description: "",
        confidence: 0.9,
        keywords: [],
        category: "safety" as const,
        relevantFiles: [],
      })),
      riskAreas: [],
      appType,
    };
  }

  it("maps known feature identifiers onto engine capabilities", () => {
    expect(
      mapFeaturesToCapabilities(makeAnalysis(["ugc", "account_creation", "subscriptions"]))
    ).toEqual(["account_creation", "subscriptions", "ugc"]);
  });

  it("normalizes spaces and dashes in feature identifiers", () => {
    expect(mapFeaturesToCapabilities(makeAnalysis(["Camera Usage", "in-app-purchases"]))).toEqual([
      "camera",
      "iap",
    ]);
  });

  it("ignores unknown feature identifiers", () => {
    expect(mapFeaturesToCapabilities(makeAnalysis(["blockchain_wallet_thing"]))).toEqual([]);
  });

  it("derives webview_heavy from the webview-ish app types", () => {
    expect(mapFeaturesToCapabilities(makeAnalysis([], "web-wrapper"))).toEqual(["webview_heavy"]);
    expect(mapFeaturesToCapabilities(makeAnalysis([], "webview-heavy"))).toEqual(["webview_heavy"]);
    expect(mapFeaturesToCapabilities(makeAnalysis([], "native"))).toEqual([]);
  });

  it("dedupes and sorts the result", () => {
    expect(
      mapFeaturesToCapabilities(makeAnalysis(["webview", "ugc", "user_generated_content"], "web-wrapper"))
    ).toEqual(["ugc", "webview_heavy"]);
  });
});
