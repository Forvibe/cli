// AI behavioral reviewer, v2 (hybrid pipeline). The static rule engine runs
// FIRST (src/engine); this module runs the AI pass on top of it:
//   - the prompt carries the static AppProfile digest and an explicit
//     "Already Detected By Static Analysis" list the model must not repeat,
//   - RAG stories come from the loaded RulepackBundle (not a local data dir),
//   - in deep mode, pass-1 discovered capabilities are unioned into the
//     profile and the rule engine is RE-RUN before the reviewer pass,
//   - AI findings are tagged detection "ai" and deduplicated against static
//     findings before they reach the report.
// Outcome/approval-chance scoring is NOT done here: review.ts computes the
// deterministic summary over the merged findings (see report-builder.ts).

import type { AIProvider } from "../ai/providers.js";
import type {
  ReviewFinding,
  ReviewRiskLevel,
  ReviewCategory,
  AppFeatureAnalysis,
} from "../types/review.js";
import type {
  AppProfile,
  Capability,
  ReviewCheck,
  RulepackBundle,
} from "../engine/types.js";
import { evaluateRules } from "../engine/rules.js";
import { detectFeatures } from "./feature-detector.js";
import {
  searchStories,
  formatStoriesForPrompt,
  type StorySignal,
} from "./rag-selector.js";

function getReviewerSimulationPrompt(): string {
  return `You are a senior member of Apple's App Review team. You have personally reviewed thousands of apps and know exactly what causes rejections.

Write all findings in English.

## YOUR MINDSET

You do NOT review code quality. You review the APP — what a user sees, touches, and experiences. You are testing this app on a real device. You are tapping buttons, reading screens, navigating flows, and checking if the experience meets Apple's standards.

For every issue, think through this exact scenario:
"I downloaded this app on my iPhone. I opened it. I [did something specific]. I saw [specific result]. This violates Guideline [X.X] because [reason]."

## STATIC ANALYSIS ALREADY RAN

A deterministic static rule engine scanned this codebase before you. The user prompt contains a section titled "## Already Detected By Static Analysis (do not repeat)". Those violations are CONFIRMED and already in the final report.

HARD RULES:
1. You MUST NOT re-report anything listed in that section. A finding that duplicates a listed guideline violation will be discarded.
2. Focus on what static analysis CANNOT see:
   - Minimum functionality and app completeness (Guideline 4.2): is this a real, useful app or a thin shell?
   - Spam, template, and repetitive app patterns (Guideline 4.3)
   - User-generated content without moderation: report, block, and filter mechanisms (Guideline 1.2)
   - Misleading claims, undelivered features, fake functionality (Guideline 2.3.1)
   - Purchase flows that bypass or confuse Apple's in-app purchase system (Guidelines 3.1.x)
   - Objectionable or age-inappropriate content (Guideline 1.1)
3. Every finding MUST cite a specific guideline number AND describe the user-visible impact.

## WHAT YOU CHECK (as if using the app)

1. **First Launch**: What happens when I open the app? Does it crash? Show a blank screen? Force me to log in? Ask for too many permissions at once?

2. **Account Flow**: If I create an account, can I also delete it? Is the delete option easy to find? Does the app force registration for basic features?

3. **Payment Experience**: If there are subscriptions/purchases:
   - Are the price, duration, and auto-renewal terms clearly shown BEFORE I tap purchase?
   - Is there a "Restore Purchases" button I can find?
   - Am I being sent to a website to pay for digital content? (That's a rejection)

4. **Privacy Experience**:
   - Does the app explain WHY it needs each permission?
   - Can I find a privacy policy in the app?
   - Does it ask for App Tracking permission before tracking me?

5. **Content & Safety**:
   - If users can post content, can I report/block other users?
   - Is there inappropriate content without proper age rating?

6. **App Quality**:
   - Is this just a website in a wrapper? (WebView with no native features = rejection)
   - Does it feel like a real app or a web page?
   - Is there placeholder text, "Coming Soon" sections, or test content?

7. **Navigation & UX**:
   - Can I get back to the main screen?
   - Does the app follow iOS conventions?

## RESPONSE FORMAT

You MUST respond with valid JSON:

{
  "findings": [
    {
      "ruleId": "string (kebab-case, e.g., 'missing-account-deletion')",
      "guidelineNumber": "string (e.g., '5.1.1')",
      "guidelineName": "string",
      "severity": "high | medium | low | info",
      "category": "safety | performance | business | design | legal | common-pitfalls",
      "title": "string (e.g., 'Missing Account Deletion Option')",
      "description": "string (detailed description of the issue)",
      "userImpact": "string (what the user actually experiences — 'When I tap Settings, there is no option to delete my account')",
      "evidence": "string (code/config evidence found)",
      "file": "string | null (file where evidence was found)",
      "fixSuggestion": "string (specific actionable fix)",
      "relatedRejection": "string | null (reference to a similar rejection case if provided)"
    }
  ],
  "overallAssessment": "string (2-3 sentence assessment of the app's review readiness)"
}

Do not include an approval estimate; the final outcome is computed deterministically from the merged findings.

## IMPORTANT RULES

1. Every finding MUST describe user-visible behavior, not code patterns
2. The "userImpact" field is MANDATORY — describe what a person using the app would experience
3. Be REALISTIC — don't fabricate issues. If the app looks clean, say so
4. Reference the rejection stories provided — they show what Apple ACTUALLY enforces
5. Severity guide:
   - high: Apple would very likely reject for this (based on real cases)
   - medium: Apple might reject, especially if reviewer is strict
   - low: Improves chances but not a guaranteed rejection
   - info: Best practice suggestion
6. Focus on the TOP issues (max 10 findings). Quality over quantity.
7. CRITICAL: You are seeing a SUBSET of the codebase, not ALL of it. If you cannot find evidence of something (e.g., a "Restore Purchases" button, account deletion flow, privacy policy link), do NOT assume it is missing. Only flag it if you see CONTRADICTING evidence (e.g., subscription code exists but zero restore mechanism in ANY of the visible code). When uncertain, use severity "low" or "info" instead of "high".
8. Never flag an issue as "high" unless you have DIRECT code evidence that something is definitively wrong or missing. "I didn't see it in the provided code" is NOT sufficient evidence for a high-risk finding — the feature may exist in files not shown to you.`;
}

interface AIResponseRaw {
  findings: Array<{
    ruleId: string;
    guidelineNumber: string;
    guidelineName: string;
    severity: string;
    category: string;
    title: string;
    description: string;
    userImpact?: string;
    evidence?: string;
    file?: string | null;
    fixSuggestion: string;
    relatedRejection?: string | null;
  }>;
  overallAssessment?: string;
}

function parseAIResponse(response: string): AIResponseRaw | null {
  try {
    return JSON.parse(response) as AIResponseRaw;
  } catch {
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as AIResponseRaw;
      } catch {
        /* fall through */
      }
    }

    const objectMatch = response.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as AIResponseRaw;
      } catch {
        /* fall through */
      }
    }

    return null;
  }
}

function validateRiskLevel(s: string): ReviewRiskLevel {
  if (["high", "medium", "low", "info"].includes(s)) return s as ReviewRiskLevel;
  // Map asc-reviewer severity to risk level
  if (s === "rejection") return "high";
  if (s === "warning") return "medium";
  if (s === "recommendation") return "low";
  return "medium";
}

function validateCategory(c: string): ReviewCategory {
  if (["safety", "performance", "business", "design", "legal", "common-pitfalls"].includes(c)) {
    return c as ReviewCategory;
  }
  return "performance";
}

function convertFindings(raw: AIResponseRaw): ReviewFinding[] {
  return (raw.findings ?? []).map((f, i) => ({
    id: f.ruleId || `finding-${i + 1}`,
    title: f.title,
    risk_level: validateRiskLevel(f.severity),
    category: validateCategory(f.category),
    source: "codebase" as const,
    guideline_number: f.guidelineNumber,
    guideline_name: f.guidelineName,
    description: f.description,
    user_impact: f.userImpact ?? f.description,
    evidence: f.evidence ?? "",
    recommendation: f.fixSuggestion,
    file: f.file ?? undefined,
    related_story_id: f.relatedRejection ?? undefined,
    // No rule_id: AI findings have no backing rulepack rule.
    detection: "ai" as const,
  }));
}

// ===========================================================================
// AI-vs-static deduplication
// ===========================================================================

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Drops every AI finding whose guideline_number matches a static finding's
 * guideline_number AND whose normalized title is a near-duplicate (one title
 * contains the other after normalization). The static finding always wins:
 * it carries deterministic evidence, a rulepack rule id, and a stable fix.
 */
export function dedupeAIFindings(
  aiFindings: ReviewFinding[],
  staticFindings: ReviewFinding[]
): { kept: ReviewFinding[]; droppedCount: number } {
  const kept = aiFindings.filter((ai) => {
    const aiTitle = normalizeTitle(ai.title ?? "");
    return !staticFindings.some((st) => {
      if (st.guideline_number !== ai.guideline_number) return false;
      const stTitle = normalizeTitle(st.title ?? "");
      // Empty titles must never substring-match everything.
      if (!aiTitle || !stTitle) return false;
      return stTitle.includes(aiTitle) || aiTitle.includes(stTitle);
    });
  });
  return { kept, droppedCount: aiFindings.length - kept.length };
}

// ===========================================================================
// Deep-mode feature -> capability mapping
// ===========================================================================

// Pass-1 feature identifiers (free-form strings from the LLM, normalized to
// snake_case) mapped onto the engine's closed Capability vocabulary. Only
// identifiers with a clear counterpart are mapped; everything else is ignored.
const FEATURE_CAPABILITY_MAP: Record<string, Capability> = {
  push_notifications: "push_notifications",
  push_notification: "push_notifications",
  iap: "iap",
  in_app_purchase: "iap",
  in_app_purchases: "iap",
  subscription: "subscriptions",
  subscriptions: "subscriptions",
  ads: "ads",
  advertising: "ads",
  advertisements: "ads",
  tracking: "tracking",
  health: "health",
  healthkit: "health",
  location: "location",
  location_tracking: "location",
  camera: "camera",
  camera_usage: "camera",
  microphone: "microphone",
  contacts: "contacts",
  photos: "photos",
  photo_library: "photos",
  bluetooth: "bluetooth",
  background_audio: "background_audio",
  background_location: "background_location",
  account_creation: "account_creation",
  account_deletion: "account_deletion",
  sign_in_with_apple: "sign_in_with_apple",
  third_party_login: "third_party_login",
  social_login: "third_party_login",
  webview: "webview_heavy",
  webview_heavy: "webview_heavy",
  ugc: "ugc",
  user_generated_content: "ugc",
  external_payment: "external_payment",
  external_payments: "external_payment",
  kids_category: "kids_category",
  ai_generated_content: "ai_generated_content",
  gambling: "gambling",
  crypto: "crypto",
  cryptocurrency: "crypto",
};

/**
 * Maps pass-1 discovered features (and the webview-ish app types) onto engine
 * Capability values. Sorted for deterministic profile output.
 */
export function mapFeaturesToCapabilities(analysis: AppFeatureAnalysis): Capability[] {
  const caps = new Set<Capability>();
  for (const feature of analysis.features ?? []) {
    const key = feature.feature.toLowerCase().trim().replace(/[\s-]+/g, "_");
    const cap = FEATURE_CAPABILITY_MAP[key];
    if (cap) caps.add(cap);
  }
  if (analysis.appType === "webview-heavy" || analysis.appType === "web-wrapper") {
    caps.add("webview_heavy");
  }
  return [...caps].sort();
}

// ===========================================================================
// Prompt sections
// ===========================================================================

function formatValueOrUnknown(value: boolean | null): string {
  if (value === null) return "unknown";
  return value ? "yes" : "no";
}

/** Compact AppProfile digest for the reviewer prompt. */
function formatProfileDigest(profile: AppProfile): string {
  const lines: string[] = [];

  lines.push(`- Stack: ${profile.stack_label} (platforms: ${profile.platforms.join(", ") || "unknown"})`);
  if (profile.app.bundle_id) lines.push(`- Bundle ID: ${profile.app.bundle_id}`);

  if (profile.sdks.length > 0) {
    const byCategory = new Map<string, string[]>();
    for (const sdk of profile.sdks) {
      const names = byCategory.get(sdk.category) ?? [];
      names.push(sdk.name);
      byCategory.set(sdk.category, names);
    }
    const parts = [...byCategory.entries()].map(([category, names]) => `${category}: ${names.join(", ")}`);
    lines.push(`- Detected SDKs: ${parts.join("; ")}`);
  } else {
    lines.push("- Detected SDKs: none");
  }

  lines.push(`- Capabilities: ${profile.capabilities.join(", ") || "none detected"}`);

  const plist = profile.ios?.plist;
  if (plist) {
    const usageKeys = Object.keys(plist.usage_descriptions);
    lines.push(`- iOS usage descriptions declared: ${usageKeys.length > 0 ? usageKeys.join(", ") : "none"}`);
    if (plist.background_modes.length > 0) {
      lines.push(`- iOS background modes: ${plist.background_modes.join(", ")}`);
    }
    if (plist.ats_allows_arbitrary_loads === true) {
      lines.push("- ATS: NSAllowsArbitraryLoads is enabled");
    }
  }

  if (profile.platforms.includes("ios")) {
    const manifest = profile.ios?.privacy_manifest;
    lines.push(`- Privacy manifest: ${manifest?.app_manifest_present ? "present" : "not found"}`);
  }

  if (profile.android?.manifest_found) {
    lines.push(`- Android permissions: ${profile.android.permissions.join(", ") || "none"}`);
  }

  const signals = profile.signals;
  lines.push(
    "- Source signals: " +
      `restore purchases ${formatValueOrUnknown(signals.restore_purchases_found)}, ` +
      `account deletion ${formatValueOrUnknown(signals.account_deletion_found)}, ` +
      `privacy policy link ${formatValueOrUnknown(signals.privacy_policy_link_found)}, ` +
      `external checkout URL ${formatValueOrUnknown(signals.external_checkout_url_found)}`
  );

  return lines.join("\n");
}

/** One line per static finding: rule id + title + guideline. */
function formatAlreadyDetected(staticFindings: ReviewFinding[]): string {
  if (staticFindings.length === 0) {
    return "(none - the static rule engine found no definitive violations)";
  }
  return staticFindings
    .map((f) => `- [${f.rule_id ?? f.id}] ${f.title} (Guideline ${f.guideline_number})`)
    .join("\n");
}

// ===========================================================================
// runCodeReview v2
// ===========================================================================

export interface RunCodeReviewInput {
  provider: AIProvider;
  /** Human-readable stack label (e.g. "iOS Native (Swift/Objective-C)"). */
  platform: string;
  appName: string;
  bundleId: string;
  /** Enriched, ALREADY-REDACTED context: project tree + SDK list + source. */
  sourceContext: string;
  deep: boolean;
  profile: AppProfile;
  staticChecks: ReviewCheck[];
  staticFindings: ReviewFinding[];
  /** Loaded rulepack bundle: stories feed RAG; rules feed the deep-mode re-run. */
  bundle: RulepackBundle;
}

export interface RunCodeReviewResult {
  /** AI findings (detection "ai"), already deduplicated against static findings. */
  aiFindings: ReviewFinding[];
  /** The LLM's prose assessment (kept verbatim; never used for outcome scoring). */
  aiAssessment: string;
  /** Pass-1 feature names (deep mode only; [] otherwise). */
  featuresDetected: string[];
  ragStoriesUsed: number;
  /** How many AI findings were dropped as duplicates of static findings. */
  dedupedCount: number;
  /** Profile, possibly enriched with pass-1 capabilities (deep mode). */
  profile: AppProfile;
  /** Checks/static findings, possibly re-evaluated after capability enrichment. */
  checks: ReviewCheck[];
  staticFindings: ReviewFinding[];
}

export async function runCodeReview(input: RunCodeReviewInput): Promise<RunCodeReviewResult> {
  let profile = input.profile;
  let checks = input.staticChecks;
  let staticFindings = input.staticFindings;

  let featureAnalysis: AppFeatureAnalysis | null = null;

  if (input.deep) {
    // Pass 1: feature discovery.
    featureAnalysis = await detectFeatures(
      input.provider,
      input.platform,
      input.appName,
      input.bundleId,
      input.sourceContext
    );

    if (featureAnalysis) {
      // Union pass-1 discovered capabilities into the profile and RE-RUN the
      // rule engine. Why: AI-discovered capabilities (e.g. UGC that shows up
      // only in app behavior, never in an SDK or manifest artifact) can
      // activate rules that static detection alone could not apply. The
      // engine is pure and synchronous, so re-running is cheap and safe.
      const discovered = mapFeaturesToCapabilities(featureAnalysis);
      const added = discovered.filter((cap) => !profile.capabilities.includes(cap));
      if (added.length > 0) {
        profile = {
          ...profile,
          capabilities: [...profile.capabilities, ...added].sort(),
        };
        const rerun = evaluateRules(profile, input.bundle);
        checks = rerun.checks;
        staticFindings = rerun.findings;
      }
    }
  }

  // RAG: rank the bundle's stories by profile-derived signals (SDK ids +
  // capability names), plus pass-1 features in deep mode. Non-deep keeps the
  // general top-15 slice size; deep widens to 20 as before.
  const profileSignals: StorySignal[] = [
    ...profile.sdks.map((sdk) => sdk.id),
    ...profile.capabilities,
  ];
  const signals: StorySignal[] = featureAnalysis
    ? [...featureAnalysis.features, ...profileSignals]
    : profileSignals;
  const relevantStories = searchStories(input.bundle.stories, signals, input.deep ? 20 : 15);
  const storiesText = formatStoriesForPrompt(relevantStories);

  const featureSection = featureAnalysis
    ? `## App Analysis (from feature discovery)

**App Purpose:** ${featureAnalysis.appPurpose}
**App Type:** ${featureAnalysis.appType}

**Detected Features:**
${featureAnalysis.features.map((f) => `- ${f.feature}: ${f.description} (confidence: ${f.confidence})`).join("\n")}

**Risk Areas:**
${featureAnalysis.riskAreas.map((r) => `- ${r}`).join("\n")}

`
    : "";

  const userPrompt = `## App Information
- Platform: ${input.platform}
- App Name: ${input.appName}
- Bundle ID: ${input.bundleId}

## App Profile (from static analysis)
${formatProfileDigest(profile)}

## Already Detected By Static Analysis (do not repeat)
These violations are already confirmed and included in the report. Do NOT re-report them:

${formatAlreadyDetected(staticFindings)}

${featureSection}## Real Rejection Cases (from other developers)
These are REAL cases where Apple rejected similar apps. Use them to calibrate:

${storiesText}

## Source Code Context

${input.sourceContext}

Now review this app as an Apple reviewer testing it on a device. Focus on behavioral issues that static analysis cannot detect. What would you flag?`;

  const systemPrompt = getReviewerSimulationPrompt();
  const response = await input.provider.generateJSON(systemPrompt, userPrompt, 0.2);
  const parsed = parseAIResponse(response);

  const featuresDetected = featureAnalysis?.features.map((f) => f.feature) ?? [];

  if (!parsed) {
    return {
      aiFindings: [],
      aiAssessment: "AI analysis could not produce structured results.",
      featuresDetected,
      ragStoriesUsed: relevantStories.length,
      dedupedCount: 0,
      profile,
      checks,
      staticFindings,
    };
  }

  const converted = convertFindings(parsed);
  const { kept, droppedCount } = dedupeAIFindings(converted, staticFindings);

  return {
    aiFindings: kept,
    aiAssessment: parsed.overallAssessment || "AI review completed.",
    featuresDetected,
    ragStoriesUsed: relevantStories.length,
    dedupedCount: droppedCount,
    profile,
    checks,
    staticFindings,
  };
}
