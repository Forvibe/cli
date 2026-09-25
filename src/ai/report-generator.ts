import type { AIProvider } from "./providers.js";
import type {
  CLIProjectReport,
  CreativeDirectionHint,
  ParsedConfig,
  SDKScanResult,
  BrandingResult,
  ScreenshotDensity,
  ScreenshotDesignHints,
  ScreenshotFeatureHint,
  ScreenshotRadiusStyle,
  ScreenshotShadowStyle,
  ScreenshotTheme,
  TechStackResult,
} from "../types/report.js";

interface ReportInput {
  techStack: TechStackResult;
  config: ParsedConfig;
  sdkScan: SDKScanResult;
  branding: BrandingResult;
  readmeContent: string | null;
  sourceCode: string;
  projectTree: string | null;
}

const SYSTEM_PROMPT = `You are a senior mobile app analyst and App Store Optimization specialist. You will receive technical data about a mobile application project including its tech stack, dependencies, config files, README, project file tree, and source code excerpts.

Your job is to deeply analyze the project and produce a comprehensive structured JSON analysis report.

## ANALYSIS APPROACH — THINK LIKE A DETECTIVE:
1. Study the PROJECT FILE TREE carefully. Directory names like "screens/", "models/", "services/", "pages/" reveal the app's architecture. File names like "plant_detail.dart", "watering_schedule.dart", "shop_screen.dart" reveal features.
2. Read the SOURCE CODE thoroughly. Look for: screen/page names, navigation routes, data models, API calls, UI components, business logic, state management patterns.
3. Cross-reference the README (if available) with actual code to understand the app's purpose.
4. Even if the source code is minimal (e.g., a new project), infer the app's intent from naming conventions, file structure, bundle ID, and any available context.

## DESCRIPTION REQUIREMENTS — THIS IS CRITICAL:
The "description" field must be a DETAILED, RICH description of 4-8 sentences that:
- Explains what the app does and its core purpose
- Describes the main features and user experience
- Mentions the target use case (e.g., "helps plant lovers track watering schedules")
- Notes any notable technical aspects (e.g., "uses real-time syncing", "leverages AI")
- If code is minimal, infer from app name, bundle ID, file structure, and README. NEVER leave this empty.
- Write as if you're explaining the app to someone who has never seen it. Be specific, not generic.

## KEY FEATURES REQUIREMENTS:
- List 5-10 specific features you can identify from the code, file tree, and README
- Each feature should be a clear, descriptive phrase (e.g., "Plant watering schedule with customizable reminders" NOT just "Scheduling")
- Infer features from file names, screen names, model classes, and navigation structure
- If you see a "shop" screen, there's a shopping feature. If you see "notification", there's push notifications. Etc.

## UNIQUE SELLING POINTS:
- 3-5 points that make this app stand out
- Be specific based on actual features found in the code

## SCREENSHOT DESIGN DIRECTION — POWERS AUTOMATED APP STORE SCREENSHOTS:
The "screenshot_design" object lets Forvibe generate App Store screenshot campaigns later without ever re-scanning this project. Ground every field in evidence you actually found in the source code, file tree, or README, and omit any optional field the evidence does not support. Never invent product facts.
- "style_idea.concept" is a short, app-specific campaign idea. Generic directions like "modern, clean, minimal gradients" are useless — name the idea this particular app's behavior suggests.
- "style_idea.metaphor" explains how real, observed product behavior can be represented visually. This is a visual proposal, not a claim that such artwork already exists.
- "style_idea.recurringMotifs" are reusable visual motifs that make the screenshot pages feel like one campaign.
- "style_idea.backgroundTreatment" and "style_idea.accentTreatment" describe meaningful use of surfaces and brand colors.
- "style_idea.pageRhythm" describes how the screenshot sequence should visually progress from first page to last.
- "screenshot_design.features" must list 3-7 of the most important, distinct, high-value features, each with a user-benefit description. SEVEN IS A MAXIMUM, NOT A TARGET — never pad with filler or trivial settings screens. This list is deliberately shorter and more curated than "key_features". If fewer than three features are substantiated by the code, return only those.
- "brand_personality" and "visual_keywords" describe the app's character and visual energy in short words.
- "typography.style", "heading_style" and "body_style" describe how the fonts the project actually uses should read.
- "style.theme", "radius_style", "density" and "shadow_style" must reflect the UI you actually observed in the source, not a preference.
- Do NOT output hex colors here; colors are extracted from the project separately.

## RESPONSE RULES:
- Respond ONLY with a valid JSON object, no markdown, no explanation
- All string values must be non-empty — NEVER return empty strings
- app_type must be one of: game, health, finance, ecommerce, education, media, utility, social, other
- advertising_type must be one of: personalized, non_personalized, none
- business_model.model must be one of: free, paid, freemium
- business_model.purchase_type must be one of: one_time, subscription, both, none
- app_category_suggestion should be an App Store category name (e.g., "Photo & Video", "Productivity", "Health & Fitness", "Lifestyle")
- target_audience should be a 2-3 sentence description of who would use this app and why`;

function buildUserPrompt(input: ReportInput): string {
  const parts: string[] = [];

  parts.push(`## Tech Stack
- Framework: ${input.techStack.label}
- Platforms: ${input.techStack.platforms.join(", ")}
- Config files found: ${input.techStack.configFiles.join(", ")}`);

  parts.push(`## Project Configuration
- App Name: ${input.config.app_name || "Unknown"}
- Bundle ID: ${input.config.bundle_id || "Unknown"}
- Version: ${input.config.version || "Unknown"}
- Min iOS: ${input.config.min_ios_version || "N/A"}
- Min Android SDK: ${input.config.min_android_sdk || "N/A"}
- Description from config: ${input.config.description || "N/A"}`);

  // Project tree is crucial for understanding app structure
  if (input.projectTree) {
    parts.push(`## Project File Tree (IMPORTANT — analyze directory and file names to understand the app's features and architecture)
${input.projectTree}`);
  }

  if (input.sdkScan.detected_sdks.length > 0) {
    parts.push(`## Detected SDKs (${input.sdkScan.detected_sdks.length})
${input.sdkScan.detected_sdks.map((sdk) => `- ${sdk.name} (${sdk.category})`).join("\n")}

Data collected: ${input.sdkScan.data_collected.join(", ") || "none detected"}
Advertising type: ${input.sdkScan.advertising_type}
Has in-app purchases: ${input.sdkScan.has_iap}`);
  } else {
    parts.push(`## Detected SDKs
No known SDKs detected in dependencies. Determine data collection and business model from source code analysis.`);
  }

  if (input.readmeContent) {
    parts.push(`## README Content (USE THIS to understand the app's purpose)
${input.readmeContent.substring(0, 8000)}`);
  }

  if (input.sourceCode) {
    parts.push(`## Source Code Excerpts (ANALYZE CAREFULLY — look for screens, routes, models, features, API calls)
${input.sourceCode.substring(0, 40000)}`);
  }

  parts.push(`## Required JSON Response Format
{
  "description": "4-8 sentence detailed description covering: what the app does, main features, target use case, and notable aspects. MUST be specific and non-empty.",
  "app_type": "one of: game, health, finance, ecommerce, education, media, utility, social, other",
  "is_for_children": false,
  "app_category_suggestion": "App Store category name (e.g. Lifestyle, Health & Fitness, Productivity)",
  "key_features": ["Detailed feature 1", "Detailed feature 2", "...up to 10 specific features found in code/tree"],
  "target_audience": "2-3 sentences describing who would use this app and why",
  "unique_selling_points": ["Specific USP 1", "Specific USP 2", "...3-5 items"],
  "business_model": {
    "model": "free | paid | freemium",
    "purchase_type": "one_time | subscription | both | none",
    "has_trial": false,
    "has_auto_renewal": false
  },
  "screenshot_design": {
    "style_idea": {
      "concept": "short app-specific campaign idea (max 160 chars)",
      "metaphor": "how observed product behavior is represented visually (max 500 chars, omit if unsupported)",
      "recurringMotifs": ["reusable motif tying pages together", "...up to 12"],
      "backgroundTreatment": "how campaign backgrounds should behave (max 500 chars)",
      "accentTreatment": "meaningful use of brand/accent colors (max 500 chars)",
      "pageRhythm": "how the page sequence progresses (max 500 chars)"
    },
    "brand_personality": ["clear", "focused", "...up to 12 short words"],
    "visual_keywords": ["calm", "organized", "...up to 20 short words"],
    "typography": {
      "style": "e.g. geometric sans-serif (max 120 chars)",
      "heading_style": "e.g. bold and compact (max 160 chars)",
      "body_style": "e.g. clear and readable (max 160 chars)"
    },
    "style": {
      "theme": "light | dark | mixed",
      "radius_style": "sharp | small | medium | large | pill",
      "density": "compact | balanced | spacious",
      "shadow_style": "none | subtle | medium | strong",
      "characteristics": ["generous whitespace", "...up to 20"]
    },
    "features": [
      { "name": "visible user benefit (max 120 chars)", "description": "truthful user outcome (max 500 chars)", "priority": 100 }
    ]
  }
}`);

  return parts.join("\n\n");
}

const THEMES: readonly ScreenshotTheme[] = ["light", "dark", "mixed"];
const RADIUS_STYLES: readonly ScreenshotRadiusStyle[] = ["sharp", "small", "medium", "large", "pill"];
const DENSITIES: readonly ScreenshotDensity[] = ["compact", "balanced", "spacious"];
const SHADOW_STYLES: readonly ScreenshotShadowStyle[] = ["none", "subtle", "medium", "strong"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function trimmedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().slice(0, maxLength) || undefined;
}

function trimmedList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => trimmedText(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function hasAnyValue(value: object): boolean {
  return Object.values(value).some((entry) => entry !== undefined);
}

/**
 * The server validates screenshot hints against a strict schema, so every field
 * is length-capped and enum-checked here rather than trusting the model output.
 */
function normalizeStyleIdea(value: unknown): CreativeDirectionHint | string | undefined {
  if (typeof value === "string") return trimmedText(value, 1200);
  const raw = asRecord(value);
  const concept = trimmedText(raw.concept, 160);
  if (!concept) return undefined;
  return {
    concept,
    metaphor: trimmedText(raw.metaphor, 500),
    recurringMotifs: trimmedList(raw.recurringMotifs, 12, 120),
    backgroundTreatment: trimmedText(raw.backgroundTreatment, 500),
    accentTreatment: trimmedText(raw.accentTreatment, 500),
    pageRhythm: trimmedText(raw.pageRhythm, 500),
  };
}

function normalizeDesignFeatures(value: unknown): ScreenshotFeatureHint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const features = value
    .map((item, index): ScreenshotFeatureHint | null => {
      const raw = asRecord(item);
      const name = trimmedText(raw.name, 120);
      if (!name) return null;
      const priority =
        typeof raw.priority === "number" && Number.isFinite(raw.priority)
          ? Math.min(100, Math.max(0, Math.round(raw.priority)))
          : Math.max(0, 100 - index * 10);
      return { name, description: trimmedText(raw.description, 500), priority };
    })
    .filter((item): item is ScreenshotFeatureHint => item !== null)
    .slice(0, 7);
  return features.length > 0 ? features : undefined;
}

function buildScreenshotDesign(
  value: unknown,
  branding: BrandingResult
): ScreenshotDesignHints | undefined {
  const raw = asRecord(value);
  const ui = branding.ui_colors;

  const uiColors = {
    accent: ui.accent ?? undefined,
    background: ui.background ?? undefined,
    surface: ui.surface ?? undefined,
    text_primary: ui.text_primary ?? undefined,
    text_secondary: ui.text_secondary ?? undefined,
  };

  const rawTypography = asRecord(raw.typography);
  const typography = {
    style: trimmedText(rawTypography.style, 120),
    heading_style: trimmedText(rawTypography.heading_style, 160),
    body_style: trimmedText(rawTypography.body_style, 160),
  };

  const rawStyle = asRecord(raw.style);
  const style = {
    // Colors come from the project itself, so the theme derived from them wins;
    // the model only fills it when no surface colors could be extracted.
    theme: ui.theme ?? pickEnum(rawStyle.theme, THEMES),
    radius_style: pickEnum(rawStyle.radius_style, RADIUS_STYLES),
    density: pickEnum(rawStyle.density, DENSITIES),
    shadow_style: pickEnum(rawStyle.shadow_style, SHADOW_STYLES),
    characteristics: trimmedList(rawStyle.characteristics, 20, 80),
  };

  const hints: ScreenshotDesignHints = {
    brand_personality: trimmedList(raw.brand_personality, 12, 60),
    visual_keywords: trimmedList(raw.visual_keywords, 20, 60),
    ui_colors: hasAnyValue(uiColors) ? uiColors : undefined,
    typography: hasAnyValue(typography) ? typography : undefined,
    style: hasAnyValue(style) ? style : undefined,
    features: normalizeDesignFeatures(raw.features),
  };

  return hasAnyValue(hints) ? hints : undefined;
}

interface AIAnalysis {
  description: string;
  app_type: string;
  is_for_children: boolean;
  app_category_suggestion: string;
  key_features: string[];
  target_audience: string;
  unique_selling_points: string[];
  business_model: {
    model: string;
    purchase_type: string;
    has_trial?: boolean;
    has_auto_renewal?: boolean;
  };
  screenshot_design?: Record<string, unknown>;
}

/**
 * Generate a comprehensive project report using the detected AI provider
 */
export async function generateReport(
  input: ReportInput,
  provider: AIProvider
): Promise<CLIProjectReport> {
  const userPrompt = buildUserPrompt(input);

  const responseText = await provider.generateJSON(SYSTEM_PROMPT, userPrompt, 0.4);
  let aiAnalysis: AIAnalysis;

  try {
    aiAnalysis = JSON.parse(responseText);
  } catch {
    // Try to extract JSON from the response and fix common issues
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const rawJson = jsonMatch ? jsonMatch[0] : responseText;

    try {
      // Fix common Gemini JSON issues: trailing commas before ] or }
      const cleaned = rawJson
        .replace(/,\s*([}\]])/g, "$1")  // Remove trailing commas
        .replace(/[\x00-\x1F\x7F]/g, (ch) =>
          ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
        ); // Remove control characters (except newlines/tabs)
      aiAnalysis = JSON.parse(cleaned);
    } catch {
      throw new Error("Failed to parse AI response as JSON");
    }
  }

  // Build the full report
  const report: CLIProjectReport = {
    // Basic identification
    app_name: input.config.app_name || "Unknown App",
    bundle_id: input.config.bundle_id || "com.unknown.app",
    description: aiAnalysis.description || input.config.description || "",
    platforms: input.techStack.platforms,
    tech_stack: input.techStack.label,
    min_os_versions: {
      ios: input.config.min_ios_version || undefined,
      android: input.config.min_android_sdk || undefined,
    },
    version: input.config.version || "1.0.0",

    // Legal/Privacy from SDK scan + AI
    app_type: (aiAnalysis.app_type as CLIProjectReport["app_type"]) || "utility",
    is_for_children: aiAnalysis.is_for_children || false,
    data_collected: input.sdkScan.data_collected,
    advertising_type: input.sdkScan.advertising_type,
    third_party_services: input.sdkScan.third_party_services,
    business_model: {
      model: (aiAnalysis.business_model?.model as "free" | "paid" | "freemium") || "free",
      purchase_type: (aiAnalysis.business_model?.purchase_type as "one_time" | "subscription" | "both" | "none") || (input.sdkScan.has_iap ? "subscription" : "none"),
      has_trial: aiAnalysis.business_model?.has_trial,
      has_auto_renewal: aiAnalysis.business_model?.has_auto_renewal,
    },

    // ASO
    app_category_suggestion: aiAnalysis.app_category_suggestion || "Utilities",
    key_features: aiAnalysis.key_features || [],
    target_audience: aiAnalysis.target_audience || "",
    unique_selling_points: aiAnalysis.unique_selling_points || [],

    // Screenshot Studio V3 hints
    screenshot_style_idea: normalizeStyleIdea(aiAnalysis.screenshot_design?.style_idea),
    screenshot_design: buildScreenshotDesign(aiAnalysis.screenshot_design, input.branding),

    // Branding
    primary_color: input.branding.primary_color || "#007AFF",
    secondary_color: input.branding.secondary_color || "#5856D6",
    brand_colors: input.branding.brand_colors.length > 0 ? input.branding.brand_colors : undefined,
    app_icon_base64: input.branding.app_icon_base64,

    // Raw data
    detected_sdks: input.sdkScan.detected_sdks,
    readme_content: input.readmeContent,
    config_files_found: input.techStack.configFiles,
  };

  return report;
}
