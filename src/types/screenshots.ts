import type { CLIAppAsset } from "./report.js";

/**
 * Screenshot Studio brief. Mirrors `CLIScreenshotBriefSchema` in
 * forvibeapp/src/lib/services/ss-studio-v3-cli-brief.ts and the
 * `CLIScreenshotDesignHints` / `CreativeDirection` types there.
 */

export interface StructuredCreativeDirection {
  concept: string;
  metaphor?: string;
  recurringMotifs?: string[];
  backgroundTreatment?: string;
  accentTreatment?: string;
  pageRhythm?: string;
}

export interface CLIScreenshotDesignHints {
  brand_personality?: string[];
  visual_keywords?: string[];
  ui_colors?: {
    accent?: string;
    background?: string;
    surface?: string;
    text_primary?: string;
    text_secondary?: string;
  };
  typography?: {
    style?: string;
    heading_style?: string;
    body_style?: string;
  };
  style?: {
    theme?: "light" | "dark" | "mixed";
    radius_style?: "sharp" | "small" | "medium" | "large" | "pill";
    density?: "compact" | "balanced" | "spacious";
    shadow_style?: "none" | "subtle" | "medium" | "strong";
    characteristics?: string[];
  };
}

export interface CLIScreenshotFeature {
  name: string;
  description?: string;
  priority?: number;
}

export interface CLIScreenshotBrief {
  app_name: string;
  bundle_id?: string;
  description?: string;
  category?: string;
  platforms?: Array<"ios" | "android">;
  tech_stack?: string;
  features: CLIScreenshotFeature[];
  screenshot_style_idea?: StructuredCreativeDirection;
  screenshot_design?: CLIScreenshotDesignHints;
  primary_color?: string;
  secondary_color?: string;
  brand_colors?: string[];
  detected_fonts?: string[];
  /** Only app_icon and screenshot assets, uploaded through presign (storage refs, never base64). */
  app_assets?: CLIAppAsset[];
  cli_version?: string;
}
