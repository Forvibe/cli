// Integration tests for runCodeReview with a STUB provider (canned JSON, no
// network, no LLM). Verifies prompt assembly (App Profile digest + Already
// Detected section), AI-finding tagging + dedup, and the deep-mode capability
// union -> evaluateRules re-run.

import { describe, it, expect } from "vitest";
import { runCodeReview } from "../../src/review/reviewer.js";
import type { AIProvider } from "../../src/ai/providers.js";
import { loadSnapshotBundle } from "../helpers/load-bundle.js";
import { makeProfile, makeFinding, makeCheck } from "../helpers/review-fixtures.js";

const bundle = loadSnapshotBundle();

const staticFindings = [
  makeFinding({
    id: "appstore.att-usage-description-missing",
    rule_id: "appstore.att-usage-description-missing",
    detection: "static",
    risk_level: "high",
    guideline_number: "5.1.2",
    title: "Tracking SDK present but NSUserTrackingUsageDescription is missing",
  }),
];

const staticChecks = [
  makeCheck({
    rule_id: "appstore.att-usage-description-missing",
    status: "fail",
    guideline_number: "5.1.2",
  }),
];

interface CapturedCall {
  systemPrompt: string;
  userPrompt: string;
}

/** Stub provider: records prompts, answers pass-1 and pass-2 with canned JSON. */
function makeStubProvider(calls: CapturedCall[], pass1Features: string[] = []): AIProvider {
  return {
    name: "Stub",
    async generateJSON(systemPrompt: string, userPrompt: string): Promise<string> {
      calls.push({ systemPrompt, userPrompt });
      if (systemPrompt.includes("expert app analyst")) {
        // Pass 1: feature discovery
        return JSON.stringify({
          appPurpose: "A social app",
          features: pass1Features.map((feature) => ({
            feature,
            description: "detected",
            confidence: 0.9,
            keywords: [feature],
            category: "safety",
            relevantFiles: [],
          })),
          riskAreas: ["ugc moderation"],
          appType: "native",
        });
      }
      // Pass 2: reviewer simulation - one duplicate of the static ATT finding
      // plus one genuinely new behavioral finding.
      return JSON.stringify({
        findings: [
          {
            ruleId: "att-missing-dup",
            guidelineNumber: "5.1.2",
            guidelineName: "Data Use and Sharing",
            severity: "high",
            category: "safety",
            title: "NSUserTrackingUsageDescription is missing",
            description: "dup",
            userImpact: "dup",
            evidence: "",
            file: null,
            fixSuggestion: "add the key",
            relatedRejection: null,
          },
          {
            ruleId: "placeholder-content",
            guidelineNumber: "2.1",
            guidelineName: "App Completeness",
            severity: "medium",
            category: "performance",
            title: "Placeholder screens visible in main flow",
            description: "Lorem ipsum on the settings screen",
            userImpact: "Users see unfinished content",
            evidence: "SettingsView.swift",
            file: "SettingsView.swift",
            fixSuggestion: "Replace placeholder content",
            relatedRejection: null,
          },
        ],
        overallAssessment: "Mostly ready, minor completeness issues.",
      });
    },
  };
}

function baseInput(provider: AIProvider, deep: boolean) {
  return {
    provider,
    platform: "iOS Native (Swift/Objective-C)",
    appName: "TestApp",
    bundleId: "com.test.app",
    sourceContext: "## Source Code\n\n--- App.swift ---\nstruct App {}",
    deep,
    profile: makeProfile(),
    staticChecks,
    staticFindings,
    bundle,
  };
}

// Run both scenarios once at module load (top-level await); assertions below
// stay synchronous, matching the repo's static-engine.test.ts pattern.
const nonDeepCalls: CapturedCall[] = [];
const nonDeepResult = await runCodeReview(baseInput(makeStubProvider(nonDeepCalls), false));

const deepCalls: CapturedCall[] = [];
const deepResult = await runCodeReview(baseInput(makeStubProvider(deepCalls, ["ugc"]), true));

describe("runCodeReview (stub provider, non-deep)", () => {
  const calls = nonDeepCalls;
  const result = nonDeepResult;

  it("makes exactly one provider call in non-deep mode", () => {
    expect(calls).toHaveLength(1);
  });

  it("injects the Already Detected section with the static finding", () => {
    expect(calls[0].userPrompt).toContain("## Already Detected By Static Analysis (do not repeat)");
    expect(calls[0].userPrompt).toContain("appstore.att-usage-description-missing");
    expect(calls[0].systemPrompt).toContain("Already Detected By Static Analysis");
  });

  it("injects the App Profile digest", () => {
    expect(calls[0].userPrompt).toContain("## App Profile (from static analysis)");
    expect(calls[0].userPrompt).toContain("iOS Native (Swift/Objective-C)");
  });

  it("drops the duplicate AI finding and keeps the new one, tagged detection ai", () => {
    expect(result.dedupedCount).toBe(1);
    expect(result.aiFindings).toHaveLength(1);
    expect(result.aiFindings[0].title).toBe("Placeholder screens visible in main flow");
    expect(result.aiFindings[0].detection).toBe("ai");
    expect(result.aiFindings[0].rule_id).toBeUndefined();
  });

  it("keeps the LLM prose and caps RAG at the general top-15 slice", () => {
    expect(result.aiAssessment).toBe("Mostly ready, minor completeness issues.");
    expect(result.ragStoriesUsed).toBeLessThanOrEqual(15);
  });

  it("returns the static results untouched in non-deep mode", () => {
    expect(result.checks).toBe(staticChecks);
    expect(result.staticFindings).toBe(staticFindings);
    expect(result.profile.capabilities).toEqual([]);
  });
});

describe("runCodeReview (stub provider, deep)", () => {
  const calls = deepCalls;
  const result = deepResult;

  it("makes two provider calls (feature discovery + reviewer)", () => {
    expect(calls).toHaveLength(2);
  });

  it("unions pass-1 capabilities into the profile", () => {
    expect(result.profile.capabilities).toContain("ugc");
    expect(result.featuresDetected).toEqual(["ugc"]);
  });

  it("re-runs evaluateRules: the ugc-gated rule is no longer na", () => {
    const ugcCheck = result.checks.find((c) => c.rule_id === "appstore.ugc-without-moderation");
    expect(ugcCheck).toBeDefined();
    expect(ugcCheck?.status).not.toBe("na");
  });

  it("the reviewer prompt reflects the re-run static state and pass-1 features", () => {
    const reviewerPrompt = calls[1].userPrompt;
    expect(reviewerPrompt).toContain("## App Analysis (from feature discovery)");
    expect(reviewerPrompt).toContain("- Capabilities: ugc");
  });
});
