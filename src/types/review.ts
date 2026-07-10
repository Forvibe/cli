// App Store Review Simulation types for CLI

// =============================================
// Core Enums
// =============================================

export type ReviewRiskLevel = "high" | "medium" | "low" | "info";

export type ReviewCategory =
  | "safety"
  | "performance"
  | "business"
  | "design"
  | "legal"
  | "common-pitfalls";

export type ReviewOutcome =
  | "likely-approved"
  | "likely-rejected"
  | "needs-attention";

// =============================================
// Feature Detection (Pass 1)
// =============================================

export interface AppFeatureSignal {
  feature: string;
  description: string;
  confidence: number;
  keywords: string[];
  category: ReviewCategory;
  relevantFiles: string[];
}

export interface AppFeatureAnalysis {
  appPurpose: string;
  features: AppFeatureSignal[];
  riskAreas: string[];
  appType: "native" | "hybrid" | "webview-heavy" | "web-wrapper";
}

// =============================================
// Review Findings
// =============================================

export interface ReviewFinding {
  id: string;
  title: string;
  risk_level: ReviewRiskLevel;
  category: ReviewCategory;
  source: "codebase";
  guideline_number: string;
  guideline_name: string;
  description: string;
  user_impact: string;
  evidence: string;
  recommendation: string;
  file?: string;
  line?: number;
  related_story_id?: string;
  // ADDITIVE (review-engine v2 / static engine): how this finding was produced.
  // "static" = deterministic rule engine (no AI). Optional so existing AI/RAG
  // producers that don't set it remain valid.
  detection?: "static" | "ai";
  // ADDITIVE: the rulepack rule id that produced this finding (mirrors `id`
  // for static findings; absent for AI findings that have no backing rule).
  rule_id?: string;
}

export interface ReviewSummary {
  total_findings: number;
  high_risk: number;
  medium_risk: number;
  low_risk: number;
  info: number;
  outcome: ReviewOutcome;
  estimated_approval_chance: number; // 0-100
  top_risks: string[];
  ai_assessment: string;
}

// =============================================
// Codebase Review Report (CLI output)
// =============================================

// Engine types are type-only imports (erased at compile time); engine/types.ts
// imports nothing from this file, so there is no import cycle at runtime.
import type { AppProfile, ReviewCheck } from "../engine/types.js";

export interface CodeReviewReport {
  features_detected: string[];
  source_files_analyzed: number;
  platform: string;
  bundle_id: string | null;
  findings: ReviewFinding[];
  summary: ReviewSummary;
  rag_stories_used: number;
  scan_duration_ms: number;
  // =============================================
  // ADDITIVE v2 fields (hybrid static + AI pipeline). Every field is optional
  // so existing v1 report consumers (the forvibeapp server's
  // /api/review/codebase endpoint and stored v1 reports) remain valid.
  // =============================================
  /** Report shape marker: present (=2) only on reports from the v2 pipeline. */
  report_schema_version?: 2;
  /** CLI package version that produced this report. */
  engine_version?: string;
  /** Version of the rulepack bundle the static engine evaluated. */
  rulepack_version?: string;
  rulepack_store?: "appstore" | "play";
  /** Where the rulepack came from at run time (freshness telemetry; also rendered in the formatter footer). */
  rulepack_source?: "remote" | "cache" | "bundled";
  /** Static-engine app profile (raw_dependencies buckets capped for payload size). */
  app_profile?: AppProfile;
  /** Full tri-state compliance check list (pass/fail/unverified/na). */
  checks?: ReviewCheck[];
  /** False when the AI behavioral pass was skipped (--static-only or no API key). */
  ai_review_ran?: boolean;
}

export type ReviewFormat = "terminal" | "json" | "markdown";
