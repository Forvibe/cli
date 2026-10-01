import type { AIProvider } from "./providers.js";
import { redactSecrets } from "../engine/redactor.js";
import type { BrandingResult, ParsedConfig, TechStackResult } from "../types/report.js";
import type {
  CLIScreenshotBrief,
  CLIScreenshotDesignHints,
  CLIScreenshotFeature,
  StructuredCreativeDirection,
} from "../types/screenshots.js";

/**
 * Screenshot Studio brief: what the app does and how its brand looks, derived
 * locally from the codebase. Forvibe plans App Store screenshots from it. The
 * code only ever goes to the user's own AI provider, after secret redaction.
 */

export interface ScreenshotBriefInput {
  techStack: TechStackResult;
  config: ParsedConfig;
  branding: BrandingResult;
  detectedFonts: string[];
  readmeContent: string | null;
  sourceCode: string;
  projectTree: string | null;
  screenshotCount: number;
}

const SYSTEM_PROMPT = `You are the creative director of a mobile app's App Store screenshots. You read the app's code to understand what users can actually do and how the product looks. Forvibe will plan the screenshot set from your brief: one opening "hook" page with artwork, then one page per feature showing the real app.

Return ONLY a JSON object:
{
  "description": "One or two sentences: what the app does for its user.",
  "category": "App Store style category, e.g. Education, Health & Fitness, Productivity",
  "features": [
    { "name": "Short user-facing feature name (2-5 words)", "description": "The user benefit in one sentence", "priority": 0-100 }
  ],
  "brand_personality": ["3-5 adjectives, e.g. calm, playful, premium"],
  "visual_keywords": ["3-8 concrete visual cues from the UI, e.g. rounded cards, soft gradients, dense data tables"],
  "ui_colors": { "accent": "#RRGGBB", "background": "#RRGGBB", "surface": "#RRGGBB", "text_primary": "#RRGGBB", "text_secondary": "#RRGGBB" },
  "typography": { "style": "e.g. geometric sans", "heading_style": "e.g. bold, tight", "body_style": "e.g. regular, comfortable" },
  "style": { "theme": "light|dark|mixed", "radius_style": "sharp|small|medium|large|pill", "density": "compact|balanced|spacious", "shadow_style": "none|subtle|medium|strong", "characteristics": ["short phrases"] },
  "screenshot_style_idea": {
    "concept": "A short name for an app-specific campaign idea",
    "metaphor": "How the product's real behavior could become a visual",
    "recurringMotifs": ["2-4 motifs that could repeat across pages"],
    "backgroundTreatment": "How backgrounds should feel",
    "accentTreatment": "Where the brand accent should appear",
    "pageRhythm": "How the set should progress"
  }
}

RULES
- features: 3 to 7 real, user-facing capabilities you can see implemented in the code (screens, views, flows). Order by importance with priority. No settings, onboarding, login, or generic items like "Beautiful design". Never invent features.
- Colors: only hex values found in the code or assets, or clearly implied by them. Omit a color you cannot ground.
- Ground everything in the supplied evidence. Omit a field rather than guess.
- Never include secrets, keys, credentials, personal data, or code in the output.`;

const HEX = /^#[0-9a-fA-F]{6}$/;
const THEMES = ["light", "dark", "mixed"] as const;
const RADII = ["sharp", "small", "medium", "large", "pill"] as const;
const DENSITIES = ["compact", "balanced", "spacious"] as const;
const SHADOWS = ["none", "subtle", "medium", "strong"] as const;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function list(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => text(item, maxLength)).filter((item): item is string => Boolean(item)).slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

function color(value: unknown): string | undefined {
  return typeof value === "string" && HEX.test(value.trim()) ? value.trim().toUpperCase() : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

export function buildScreenshotBriefPrompt(input: ScreenshotBriefInput): string {
  const readme = input.readmeContent ? redactSecrets(input.readmeContent).text.slice(0, 8000) : null;
  const source = redactSecrets(input.sourceCode).text.slice(0, 40000);
  return [
    `APP NAME: ${input.config.app_name ?? "unknown"}`,
    `PLATFORMS: ${input.techStack.platforms.join(", ")} (${input.techStack.label})`,
    `BRAND COLORS FOUND: ${[input.branding.primary_color, input.branding.secondary_color, ...input.branding.brand_colors].filter(Boolean).join(", ") || "none"}`,
    `FONTS FOUND: ${input.detectedFonts.join(", ") || "none (system fonts)"}`,
    `EXISTING SCREENSHOTS IN REPO: ${input.screenshotCount}`,
    "",
    readme ? `README:\n${readme}` : "README: none",
    "",
    input.projectTree ? `PROJECT TREE:\n${input.projectTree.slice(0, 6000)}` : "",
    "",
    `SOURCE EXCERPTS (secrets redacted):\n${source}`,
  ].join("\n");
}

function parseJson(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The AI response did not contain JSON");
    return JSON.parse(match[0].replace(/,\s*([}\]])/g, "$1"));
  }
}

function structuredDirection(value: unknown): StructuredCreativeDirection | undefined {
  const raw = record(value);
  const concept = text(raw.concept, 160);
  if (!concept) return undefined;
  return compact({
    concept,
    metaphor: text(raw.metaphor, 500),
    recurringMotifs: list(raw.recurringMotifs, 12, 120),
    backgroundTreatment: text(raw.backgroundTreatment, 500),
    accentTreatment: text(raw.accentTreatment, 500),
    pageRhythm: text(raw.pageRhythm, 500),
  }) as StructuredCreativeDirection;
}

/** Validates model output against the brief contract; everything unknown is dropped. */
export function normalizeScreenshotBrief(raw: unknown, input: ScreenshotBriefInput): Omit<CLIScreenshotBrief, "app_assets" | "cli_version"> {
  const data = record(raw);
  const seen = new Set<string>();
  const features: CLIScreenshotFeature[] = (Array.isArray(data.features) ? data.features : [])
    .map((item, index) => {
      const feature = record(item);
      const name = text(feature.name, 120);
      if (!name || seen.has(name.toLowerCase())) return null;
      seen.add(name.toLowerCase());
      const priority = typeof feature.priority === "number" && Number.isFinite(feature.priority)
        ? Math.max(0, Math.min(100, Math.round(feature.priority)))
        : Math.max(0, 100 - index * 10);
      return compact({ name, description: text(feature.description, 500), priority }) as CLIScreenshotFeature;
    })
    .filter((feature): feature is CLIScreenshotFeature => feature !== null)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 7);
  if (features.length < 3) {
    throw new Error(`The AI found ${features.length} feature${features.length === 1 ? "" : "s"}; Screenshot Studio needs at least 3. Add a README that lists what the app does, then run the CLI again.`);
  }
  const uiColors = record(data.ui_colors);
  const typography = record(data.typography);
  const style = record(data.style);
  const design: CLIScreenshotDesignHints | undefined = compact({
    brand_personality: list(data.brand_personality, 12, 60),
    visual_keywords: list(data.visual_keywords, 20, 60),
    ui_colors: compact({
      accent: color(uiColors.accent),
      background: color(uiColors.background),
      surface: color(uiColors.surface),
      text_primary: color(uiColors.text_primary),
      text_secondary: color(uiColors.text_secondary),
    }),
    typography: compact({
      style: text(typography.style, 120),
      heading_style: text(typography.heading_style, 160),
      body_style: text(typography.body_style, 160),
    }),
    style: compact({
      theme: oneOf(style.theme, THEMES),
      radius_style: oneOf(style.radius_style, RADII),
      density: oneOf(style.density, DENSITIES),
      shadow_style: oneOf(style.shadow_style, SHADOWS),
      characteristics: list(style.characteristics, 20, 80),
    }),
  });
  const platforms = input.techStack.platforms.filter((platform): platform is "ios" | "android" => platform === "ios" || platform === "android");
  const brandColors = [...new Set(input.branding.brand_colors.map(color).filter((value): value is string => Boolean(value)))].slice(0, 8);
  return compact({
    app_name: text(input.config.app_name, 120) ?? "Untitled App",
    bundle_id: text(input.config.bundle_id, 200),
    description: text(data.description, 1200),
    category: text(data.category, 120),
    platforms: platforms.length > 0 ? platforms : undefined,
    tech_stack: text(input.techStack.stack, 60),
    features,
    screenshot_style_idea: structuredDirection(data.screenshot_style_idea),
    screenshot_design: design,
    primary_color: color(input.branding.primary_color),
    secondary_color: color(input.branding.secondary_color),
    brand_colors: brandColors.length > 0 ? brandColors : undefined,
    detected_fonts: input.detectedFonts.length > 0 ? input.detectedFonts.slice(0, 8) : undefined,
  }) as Omit<CLIScreenshotBrief, "app_assets" | "cli_version">;
}

export async function generateScreenshotBrief(input: ScreenshotBriefInput, provider: AIProvider) {
  const response = await provider.generateJSON(SYSTEM_PROMPT, buildScreenshotBriefPrompt(input), 0.4);
  return normalizeScreenshotBrief(parseJson(response.replace(/^```(?:json)?\s*|\s*```\s*$/g, "")), input);
}
