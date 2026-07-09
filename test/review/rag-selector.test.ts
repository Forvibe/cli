import { describe, it, expect } from "vitest";
import { searchStories, formatStoriesForPrompt } from "../../src/review/rag-selector.js";
import type { RejectionStory } from "../../src/engine/types.js";
import type { AppFeatureSignal } from "../../src/types/review.js";

function makeStory(overrides: Partial<RejectionStory> = {}): RejectionStory {
  return {
    id: "story",
    store: "appstore",
    guidelineNumber: "5.1.1",
    guidelineName: "Privacy",
    category: "safety",
    rejectionReason: "reason",
    whatDeveloperDid: "did something",
    whatAppleSaid: "said something",
    fix: "fixed it",
    outcome: "resolved",
    keywords: [],
    behavioralSignals: [],
    ...overrides,
  };
}

const ugcStory = makeStory({
  id: "ugc-story",
  category: "safety",
  keywords: ["ugc", "moderation"],
  behavioralSignals: ["ugc feed visible without report button"],
});

const iapStory = makeStory({
  id: "iap-story",
  category: "business",
  guidelineNumber: "3.1.1",
  keywords: ["subscription", "restore"],
  behavioralSignals: ["subscription paywall shown at launch"],
});

const genericStory = makeStory({
  id: "generic-story",
  category: "design",
  guidelineNumber: "4.0",
  keywords: ["metadata"],
  behavioralSignals: ["screenshots do not match the app"],
});

const stories = [genericStory, ugcStory, iapStory];

describe("searchStories (injected stories)", () => {
  it("returns the leading slice unranked when there are no signals", () => {
    expect(searchStories(stories, [], 2).map((s) => s.id)).toEqual([
      "generic-story",
      "ugc-story",
    ]);
  });

  it("ranks by plain string signals (SDK ids / capability names)", () => {
    // "subscription": +3 (behavioral signal contains it) +2 (keyword) = 5 for iap-story
    const ranked = searchStories(stories, ["subscription"], 3);
    expect(ranked[0].id).toBe("iap-story");
  });

  it("ranks by feature-shaped signals with keyword and category scoring", () => {
    const signal: AppFeatureSignal = {
      feature: "ugc",
      description: "users can post",
      confidence: 0.9,
      keywords: ["moderation"],
      category: "safety",
      relevantFiles: [],
    };
    // ugc-story: +3 (behavioral contains "ugc") +2 (keyword "moderation") +1 (category safety) = 6
    const ranked = searchStories(stories, [signal], 3);
    expect(ranked[0].id).toBe("ugc-story");
  });

  it("mixes plain and feature-shaped signals", () => {
    const signal: AppFeatureSignal = {
      feature: "ugc",
      description: "",
      confidence: 0.8,
      keywords: [],
      category: "safety",
      relevantFiles: [],
    };
    const ranked = searchStories(stories, [signal, "subscription"], 3);
    const topTwo = ranked.slice(0, 2).map((s) => s.id);
    expect(topTwo).toContain("ugc-story");
    expect(topTwo).toContain("iap-story");
    expect(ranked[2].id).toBe("generic-story");
  });

  it("respects maxResults", () => {
    expect(searchStories(stories, ["subscription"], 1)).toHaveLength(1);
    expect(searchStories(stories, [], 10)).toHaveLength(3);
  });
});

describe("formatStoriesForPrompt", () => {
  it("formats stories with guideline, quote, fix and signals", () => {
    const text = formatStoriesForPrompt([iapStory]);
    expect(text).toContain("Case 1: Privacy (Guideline 3.1.1)");
    expect(text).toContain('"said something"');
    expect(text).toContain("subscription paywall shown at launch");
  });

  it("handles an empty list", () => {
    expect(formatStoriesForPrompt([])).toBe("No relevant rejection stories found.");
  });
});
