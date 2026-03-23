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
// RAG - Rejection Stories
// =============================================

export interface RejectionStory {
  id: string;
  guidelineNumber: string;
  guidelineName: string;
  category: ReviewCategory;
  rejectionReason: string;
  whatDeveloperDid: string;
  whatAppleSaid: string;
  fix: string;
  outcome: string;
  keywords: string[];
  behavioralSignals: string[];
  year?: number;
}

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

export interface CodeReviewReport {
  features_detected: string[];
  source_files_analyzed: number;
  platform: string;
  bundle_id: string | null;
  findings: ReviewFinding[];
  summary: ReviewSummary;
  rag_stories_used: number;
  scan_duration_ms: number;
}

export type ReviewFormat = "terminal" | "json" | "markdown";
