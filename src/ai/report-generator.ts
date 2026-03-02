import type { AIProvider } from "./providers.js";
import type {
  CLIProjectReport,
  ParsedConfig,
  SDKScanResult,
  BrandingResult,
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
  }
}`);

  return parts.join("\n\n");
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

    // Branding
    primary_color: input.branding.primary_color || "#007AFF",
    secondary_color: input.branding.secondary_color || "#5856D6",
    app_icon_base64: input.branding.app_icon_base64,

    // Raw data
    detected_sdks: input.sdkScan.detected_sdks,
    readme_content: input.readmeContent,
    config_files_found: input.techStack.configFiles,
  };

  return report;
}
