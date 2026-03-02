import type { AIProvider } from "./providers.js";
import type { CLIProjectReport, ASOContent } from "../types/report.js";

const ASO_SYSTEM_PROMPT = `You are a world-class App Store Optimization (ASO) specialist with deep expertise in keyword strategy, conversion optimization, and store listing copywriting.

Your task is to generate a complete, ASO-optimized store listing for a mobile app.

## APP STORE (iOS) RULES — STRICTLY ENFORCE CHARACTER LIMITS:
- app_name: maximum 30 characters. Include primary keyword. Be memorable and brandable.
- subtitle: maximum 30 characters. Complement the app name with secondary keywords. Do NOT repeat words from the app name.
- description: maximum 4000 characters. The FIRST SENTENCE is critical — it's visible before "Read More". Use feature bullets with line breaks. Include a call-to-action at the end. Naturally weave keywords without stuffing. Use only standard dash (-) or bullet (•) characters for lists. NEVER use special unicode symbols like ★, ✓, ✔, ⭐, ❤, ●, ■, ▶, ☑ — App Store Connect REJECTS these characters.
- keywords: maximum 100 characters. Comma-separated with NO spaces after commas. Do NOT include words already in the app name or subtitle. Prioritize single words over phrases. Use ALL available characters. Focus on high-search-volume, low-competition terms.
- promotional_text: maximum 170 characters. Engaging hook highlighting the app's core value proposition.
- whats_new: maximum 170 characters. For v1.0, highlight key launch features.

## PLAY STORE (Android) RULES — ONLY IF ANDROID PLATFORM:
- title: maximum 30 characters. Can differ from iOS app_name for better Play Store optimization.
- short_description: maximum 80 characters. Concise value proposition. Must be different from subtitle.
- description: maximum 4000 characters. Play Store descriptions can use HTML formatting (<b>, <i>, <br>). Focus on features and benefits.
- whats_new: maximum 500 characters. Release notes for initial launch.

## ASO BEST PRACTICES:
1. Front-load keywords in title and first line of description
2. Avoid generic words ("best", "free", "app") in keywords — they waste characters
3. Use long-tail keyword variations across different fields
4. Description should answer: What does the app do? Why should I download it? What makes it unique?
5. Each keyword in the keywords field should be a single word or short phrase, never repeat words across keyword field, app name, and subtitle
6. Write in English (en-US locale)

Respond ONLY with a valid JSON object, no markdown, no explanation.`;

function buildASOPrompt(report: CLIProjectReport): string {
  const parts: string[] = [];

  parts.push(`## App Information
- App Name: ${report.app_name}
- Bundle ID: ${report.bundle_id}
- Description: ${report.description}
- App Type: ${report.app_type}
- Category: ${report.app_category_suggestion}
- Tech Stack: ${report.tech_stack}
- Platforms: ${report.platforms.join(", ")}
- Version: ${report.version}`);

  parts.push(`## Key Features
${report.key_features.map((f, i) => `${i + 1}. ${f}`).join("\n")}`);

  parts.push(`## Target Audience
${report.target_audience}`);

  parts.push(`## Unique Selling Points
${report.unique_selling_points.map((u) => `- ${u}`).join("\n")}`);

  parts.push(`## Business Model
- Model: ${report.business_model.model}
- Purchase Type: ${report.business_model.purchase_type}`);

  if (report.readme_content) {
    parts.push(`## README (for additional context)
${report.readme_content.substring(0, 3000)}`);
  }

  const includePlayStore = report.platforms.includes("android");

  parts.push(`## Required JSON Response Format
{
  "appstore": {
    "app_name": "max 30 chars, keyword-rich app name",
    "subtitle": "max 30 chars, complementary keywords",
    "description": "max 4000 chars, ASO-optimized with bullets and line breaks",
    "keywords": "keyword1,keyword2,keyword3 (max 100 chars, NO spaces after commas)",
    "promotional_text": "max 170 chars, engaging hook",
    "whats_new": "max 170 chars, launch highlights"
  }${
    includePlayStore
      ? `,
  "playstore": {
    "title": "max 30 chars, Play Store optimized title",
    "short_description": "max 80 chars, concise value proposition",
    "description": "max 4000 chars, HTML formatting allowed",
    "whats_new": "max 500 chars, launch release notes"
  }`
      : ""
  }
}`);

  return parts.join("\n\n");
}

interface RawASOResponse {
  appstore: {
    app_name: string;
    subtitle: string;
    description: string;
    keywords: string;
    promotional_text: string;
    whats_new: string;
  };
  playstore?: {
    title: string;
    short_description: string;
    description: string;
    whats_new: string;
  };
}

function truncateKeywords(keywords: string, maxLength: number): string {
  if (keywords.length <= maxLength) return keywords;

  const parts = keywords.split(",");
  let result = "";

  for (const part of parts) {
    const candidate = result ? `${result},${part}` : part;
    if (candidate.length > maxLength) break;
    result = candidate;
  }

  return result || keywords.substring(0, maxLength);
}

function enforceCharLimits(raw: RawASOResponse): ASOContent {
  const result: ASOContent = {
    appstore: {
      app_name: (raw.appstore.app_name || "").substring(0, 30),
      subtitle: (raw.appstore.subtitle || "").substring(0, 30),
      description: (raw.appstore.description || "").substring(0, 4000),
      keywords: truncateKeywords(raw.appstore.keywords || "", 100),
      promotional_text: (raw.appstore.promotional_text || "").substring(0, 170),
      whats_new: (raw.appstore.whats_new || "").substring(0, 170),
    },
  };

  if (raw.playstore) {
    result.playstore = {
      title: (raw.playstore.title || "").substring(0, 30),
      short_description: (raw.playstore.short_description || "").substring(0, 80),
      description: (raw.playstore.description || "").substring(0, 4000),
      whats_new: (raw.playstore.whats_new || "").substring(0, 500),
    };
  }

  return result;
}

/**
 * Generate ASO-optimized store listing content using the detected AI provider
 */
export async function generateASOContent(
  report: CLIProjectReport,
  provider: AIProvider
): Promise<ASOContent> {
  const userPrompt = buildASOPrompt(report);

  const responseText = await provider.generateJSON(ASO_SYSTEM_PROMPT, userPrompt, 0.5);
  let parsed: RawASOResponse;

  try {
    parsed = JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const rawJson = jsonMatch ? jsonMatch[0] : responseText;

    try {
      // Fix common Gemini JSON issues: trailing commas before ] or }
      const cleaned = rawJson
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/[\x00-\x1F\x7F]/g, (ch) =>
          ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
        );
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("Failed to parse ASO AI response as JSON");
    }
  }

  if (!parsed.appstore) {
    throw new Error("AI response missing appstore field");
  }

  return enforceCharLimits(parsed);
}
