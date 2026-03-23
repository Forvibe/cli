import type { AIProvider } from "../ai/providers.js";
import type {
  ReviewFinding,
  ReviewSummary,
  ReviewRiskLevel,
  ReviewCategory,
  ReviewOutcome,
  CodeReviewReport,
  AppFeatureAnalysis,
} from "../types/review.js";
import { detectFeatures } from "./feature-detector.js";
import {
  searchStories,
  formatStoriesForPrompt,
  loadAllStories,
} from "./rag-selector.js";

function getReviewerSimulationPrompt(): string {
  return `You are a senior member of Apple's App Review team. You have personally reviewed thousands of apps and know exactly what causes rejections.

Write all findings in English.

## YOUR MINDSET

You do NOT review code quality. You review the APP — what a user sees, touches, and experiences. You are testing this app on a real device. You are tapping buttons, reading screens, navigating flows, and checking if the experience meets Apple's standards.

For every issue, think through this exact scenario:
"I downloaded this app on my iPhone. I opened it. I [did something specific]. I saw [specific result]. This violates Guideline [X.X] because [reason]."

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
  "overallAssessment": "string (2-3 sentence assessment of the app's review readiness)",
  "estimatedOutcome": "likely-approved | likely-rejected | needs-attention",
  "estimatedApprovalChance": 0-100
}

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
  overallAssessment: string;
  estimatedOutcome: string;
  estimatedApprovalChance?: number;
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

function validateOutcome(o: string): ReviewOutcome {
  if (["likely-approved", "likely-rejected", "needs-attention"].includes(o)) {
    return o as ReviewOutcome;
  }
  return "needs-attention";
}

function convertFindings(raw: AIResponseRaw): ReviewFinding[] {
  return raw.findings.map((f, i) => ({
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
  }));
}

function buildSummary(
  findings: ReviewFinding[],
  aiResponse: AIResponseRaw
): ReviewSummary {
  const high = findings.filter((f) => f.risk_level === "high").length;
  const medium = findings.filter((f) => f.risk_level === "medium").length;
  const low = findings.filter((f) => f.risk_level === "low").length;
  const info = findings.filter((f) => f.risk_level === "info").length;

  const outcome = validateOutcome(aiResponse.estimatedOutcome);

  let approvalChance = aiResponse.estimatedApprovalChance ?? 75;
  if (outcome === "likely-rejected") approvalChance = Math.min(approvalChance, 30);
  if (outcome === "likely-approved") approvalChance = Math.max(approvalChance, 70);

  const topRisks = findings
    .filter((f) => f.risk_level === "high" || f.risk_level === "medium")
    .slice(0, 3)
    .map((f) => f.title);

  return {
    total_findings: findings.length,
    high_risk: high,
    medium_risk: medium,
    low_risk: low,
    info,
    outcome,
    estimated_approval_chance: approvalChance,
    top_risks: topRisks,
    ai_assessment: aiResponse.overallAssessment,
  };
}

export async function runCodeReview(
  provider: AIProvider,
  platform: string,
  appName: string,
  bundleId: string,
  sourceCode: string,
  sourceFilesCount: number,
  deep: boolean
): Promise<CodeReviewReport> {
  const startTime = Date.now();

  let featureAnalysis: AppFeatureAnalysis | null = null;
  let relevantStories;

  if (deep) {
    // Pass 1: Feature Discovery
    featureAnalysis = await detectFeatures(
      provider,
      platform,
      appName,
      bundleId,
      sourceCode
    );

    // RAG: Find relevant stories based on detected features
    if (featureAnalysis) {
      relevantStories = searchStories(featureAnalysis.features, 20);
    } else {
      relevantStories = loadAllStories().slice(0, 15);
    }
  } else {
    // Single pass: use top general stories
    relevantStories = loadAllStories().slice(0, 15);
  }

  const storiesText = formatStoriesForPrompt(relevantStories);

  // Build user prompt
  const featureSection = featureAnalysis
    ? `## App Analysis (from feature discovery)

**App Purpose:** ${featureAnalysis.appPurpose}
**App Type:** ${featureAnalysis.appType}

**Detected Features:**
${featureAnalysis.features.map((f) => `- ${f.feature}: ${f.description} (confidence: ${f.confidence})`).join("\n")}

**Risk Areas:**
${featureAnalysis.riskAreas.map((r) => `- ${r}`).join("\n")}`
    : "";

  const userPrompt = `## App Information
- Platform: ${platform}
- App Name: ${appName}
- Bundle ID: ${bundleId}

${featureSection}

## Real Rejection Cases (from other developers)
These are REAL cases where Apple rejected similar apps. Use them to calibrate:

${storiesText}

## Source Code

${sourceCode}

Now review this app as an Apple reviewer testing it on a device. What would you flag?`;

  // Pass 2 (or single pass): AI Review
  const systemPrompt = getReviewerSimulationPrompt();
  const response = await provider.generateJSON(systemPrompt, userPrompt, 0.2);
  const parsed = parseAIResponse(response);

  if (!parsed) {
    return {
      features_detected: featureAnalysis?.features.map((f) => f.feature) ?? [],
      source_files_analyzed: sourceFilesCount,
      platform,
      bundle_id: bundleId || null,
      findings: [],
      summary: {
        total_findings: 0,
        high_risk: 0,
        medium_risk: 0,
        low_risk: 0,
        info: 0,
        outcome: "needs-attention",
        estimated_approval_chance: 50,
        top_risks: [],
        ai_assessment: "AI analysis could not produce structured results.",
      },
      rag_stories_used: relevantStories.length,
      scan_duration_ms: Date.now() - startTime,
    };
  }

  const findings = convertFindings(parsed);
  const summary = buildSummary(findings, parsed);

  return {
    features_detected: featureAnalysis?.features.map((f) => f.feature) ?? [],
    source_files_analyzed: sourceFilesCount,
    platform,
    bundle_id: bundleId || null,
    findings,
    summary,
    rag_stories_used: relevantStories.length,
    scan_duration_ms: Date.now() - startTime,
  };
}
