import { describe, it, expect } from "vitest";
import {
  dedupeAIFindings,
  mapFeaturesToCapabilities,
  filterUnsupportedAIFindings,
} from "../../src/review/reviewer.js";
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

describe("filterUnsupportedAIFindings", () => {
  const corpusPaths = new Set(["lib/features/settings/view/settings_view.dart"]);

  it("drops a missing-feature claim the deterministic scan already disproved", () => {
    // The exact finding that shipped in a real report: "no account deletion",
    // asserted from a 35-of-264-file corpus, while deleteAccount sat in three
    // files the model was never shown.
    const findings = [
      makeFinding({
        id: "ai-1",
        title: "Missing Account Deletion Option",
        description: "The app offers no way to delete your account.",
        guideline_number: "5.1.1(v)",
        file: "lib/features/settings/view/settings_view.dart",
      }),
    ];

    const r = filterUnsupportedAIFindings(findings, {
      corpusPaths,
      resolvedTrue: ["account_deletion"],
    });

    expect(r.kept).toHaveLength(0);
    expect(r.droppedCount).toBe(1);
  });

  it("drops an absence claim that cites a file we never showed the model", () => {
    const findings = [
      makeFinding({
        id: "ai-2",
        title: "Privacy policy link is missing",
        description: "No privacy policy link was found.",
        guideline_number: "5.1.1",
        file: "lib/invented/nowhere.dart",
      }),
    ];

    const r = filterUnsupportedAIFindings(findings, { corpusPaths, resolvedTrue: [] });

    expect(r.kept).toHaveLength(0);
  });

  it("drops an absence claim carrying no file at all", () => {
    const findings = [
      makeFinding({
        id: "ai-3",
        title: "No restore purchases button",
        description: "Subscriptions without a restore option.",
        guideline_number: "3.1.2",
      }),
    ];

    expect(
      filterUnsupportedAIFindings(findings, { corpusPaths, resolvedTrue: [] }).kept
    ).toHaveLength(0);
  });

  it("keeps a presence claim backed by a real file", () => {
    const findings = [
      makeFinding({
        id: "ai-4",
        title: "Paywall dismisses without a visible close control",
        description: "The paywall traps the user on first launch.",
        guideline_number: "3.1.2",
        evidence: "showPaywall(barrierDismissible: false)",
        file: "lib/features/settings/view/settings_view.dart",
      }),
    ];

    const r = filterUnsupportedAIFindings(findings, {
      corpusPaths,
      resolvedTrue: ["restore_purchases"],
    });

    expect(r.kept).toHaveLength(1);
    expect(r.droppedCount).toBe(0);
  });

  it("downgrades a high-risk finding that quotes no evidence", () => {
    const findings = [
      makeFinding({
        id: "ai-5",
        title: "App appears to be a web wrapper",
        description: "Most screens look like web views.",
        risk_level: "high",
        evidence: "",
        file: "lib/features/settings/view/settings_view.dart",
      }),
    ];

    const r = filterUnsupportedAIFindings(findings, { corpusPaths, resolvedTrue: [] });

    expect(r.kept[0].risk_level).toBe("medium");
    expect(r.downgradedCount).toBe(1);
  });
});
