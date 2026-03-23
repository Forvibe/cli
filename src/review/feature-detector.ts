import type { AIProvider } from "../ai/providers.js";
import type { AppFeatureAnalysis } from "../types/review.js";

export function getFeatureDiscoveryPrompt(): string {
  return `You are an expert app analyst. Your job is to understand WHAT an app does from the USER's perspective by reading its source code. You are NOT reviewing code quality.

Respond in English.

Answer this question: "If someone downloads this app and opens it on their iPhone, what will they see and experience?"

Analyze the source code and identify:

1. **App Purpose**: What does this app do? (1-2 sentences)
2. **User Flows**: What are the main things a user can do? (list each)
3. **Onboarding**: What happens when you first open the app? Login required? Permissions asked immediately?
4. **Monetization**: How does the app make money? Subscriptions? IAP? Ads? External payments? Free?
5. **Data & Privacy**: What user data does the app collect? What device permissions does it need? Is there a privacy policy link?
6. **Content**: Is there user-generated content (posts, comments, chat)? Third-party content? Web content?
7. **Account Management**: Can users create accounts? Can they delete their accounts?
8. **Platform Features**: Does it use WebViews, widgets, extensions, push notifications, background processing?
9. **Settings & Legal**: What can users configure? Is there a privacy policy accessible in-app? Terms of service?
10. **External Links**: Does the app link to external payment pages, websites, or other apps?

IMPORTANT: You are seeing a SUBSET of the source code, not the entire codebase. Do not make definitive claims about features being absent — only report features you can positively identify from the code shown. If something might exist but you don't see it, do not list it as missing.

Respond ONLY with valid JSON in this exact format:

{
  "appPurpose": "string describing what the app does",
  "features": [
    {
      "feature": "string identifier (e.g., 'subscriptions', 'webview', 'ugc', 'account_creation', 'push_notifications', 'camera_usage', 'location_tracking')",
      "description": "string describing what the user experiences",
      "confidence": 0.0-1.0,
      "keywords": ["relevant", "keywords", "from", "code"],
      "category": "safety|performance|business|design|legal|common-pitfalls",
      "relevantFiles": ["file1.swift", "file2.ts"]
    }
  ],
  "riskAreas": ["string describing areas that Apple reviewers commonly flag for apps like this"],
  "appType": "native|hybrid|webview-heavy|web-wrapper"
}`;
}

export async function detectFeatures(
  provider: AIProvider,
  platform: string,
  appName: string,
  bundleId: string,
  sourceCode: string
): Promise<AppFeatureAnalysis | null> {
  const systemPrompt = getFeatureDiscoveryPrompt();
  const userPrompt = `## App Information
- Platform: ${platform}
- App Name: ${appName}
- Bundle ID: ${bundleId}

## Source Code

${sourceCode}`;

  try {
    const response = await provider.generateJSON(systemPrompt, userPrompt, 0.2);
    return parseFeatureAnalysis(response);
  } catch {
    return null;
  }
}

function parseFeatureAnalysis(response: string): AppFeatureAnalysis | null {
  try {
    return JSON.parse(response) as AppFeatureAnalysis;
  } catch {
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as AppFeatureAnalysis;
      } catch {
        /* fall through */
      }
    }

    const objectMatch = response.match(/\{[\s\S]*"features"[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as AppFeatureAnalysis;
      } catch {
        /* fall through */
      }
    }

    return null;
  }
}
