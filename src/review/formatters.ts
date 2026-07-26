// Report formatters, v2: terminal/markdown render the hybrid report's
// compliance checks, per-finding detection badges, rulepack/engine footer, and
// the static-only banner. Every v2 field is optional on CodeReviewReport, so
// a v1-shaped report (no checks/app_profile/ai_review_ran) renders exactly as
// before - v2 sections are simply omitted. formatJSON stays a raw serialize.

import chalk from "chalk";
import type { CodeReviewReport, ReviewFinding, ReviewRiskLevel } from "../types/review.js";
import type { ReviewCheck } from "../engine/types.js";

const RISK_ICONS: Record<ReviewRiskLevel, string> = {
  high: "🔴",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

const RISK_LABELS: Record<ReviewRiskLevel, string> = {
  high: "HIGH RISK",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};

const RISK_COLORS: Record<ReviewRiskLevel, (text: string) => string> = {
  high: chalk.red,
  medium: chalk.yellow,
  low: chalk.blue,
  info: chalk.gray,
};

/**
 * Coverage line with a denominator.
 *
 * "34 source files analyzed" told the user nothing about the 224 files that
 * were skipped, which is how a 13% scan came to read as a complete audit.
 * A v1-shaped report (no discovered count) still renders the legacy phrasing.
 */
function formatCoverage(report: CodeReviewReport): string {
  const analyzed = report.source_files_analyzed;
  const discovered = report.source_files_discovered;
  if (discovered === undefined || discovered <= 0) {
    return `${analyzed} source files analyzed`;
  }
  const pct = Math.round((analyzed / discovered) * 100);
  const ai = report.ai_context_files;
  const aiPart = ai !== undefined ? ` · ${ai} sent to AI` : "";
  return `${analyzed} of ${discovered} source files scanned (${pct}%)${aiPart}`;
}

const STATIC_ONLY_BANNER = "AI behavioral review skipped. Static rule results only.";

function outcomeDisplay(outcome: string): string {
  switch (outcome) {
    case "likely-approved":
      return chalk.green.bold("LIKELY APPROVED");
    case "likely-rejected":
      return chalk.red.bold("LIKELY REJECTED");
    case "needs-attention":
      return chalk.yellow.bold("NEEDS ATTENTION");
    default:
      return chalk.gray(outcome);
  }
}

function approvalBar(chance: number): string {
  const width = 20;
  const filled = Math.round((chance / 100) * width);
  const empty = width - filled;

  let color: (s: string) => string;
  if (chance >= 70) color = chalk.green;
  else if (chance >= 40) color = chalk.yellow;
  else color = chalk.red;

  return color("█".repeat(filled)) + chalk.gray("░".repeat(empty)) + ` ${chance}%`;
}

interface CheckCounts {
  failed: ReviewCheck[];
  unverified: ReviewCheck[];
  passed: ReviewCheck[];
  na: ReviewCheck[];
}

function groupChecks(checks: ReviewCheck[]): CheckCounts {
  return {
    failed: checks.filter((c) => c.status === "fail"),
    unverified: checks.filter((c) => c.status === "unverified"),
    passed: checks.filter((c) => c.status === "pass"),
    na: checks.filter((c) => c.status === "na"),
  };
}

function detectionBadge(finding: ReviewFinding): string {
  if (finding.detection === "static") return chalk.dim("[static]") + " ";
  if (finding.detection === "ai") return chalk.cyan("[AI]") + " ";
  return "";
}

/** `Rulepack v2.0.2 (bundled) · Engine v2.0.0` (parts included as available). */
function versionFooter(report: CodeReviewReport): string | null {
  const parts: string[] = [];
  if (report.rulepack_version) {
    const source = report.rulepack_source ? ` (${report.rulepack_source})` : "";
    parts.push(`Rulepack v${report.rulepack_version}${source}`);
  }
  if (report.engine_version) {
    parts.push(`Engine v${report.engine_version}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatTerminal(report: CodeReviewReport): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("  🛡️  App Store Review Simulation"));
  lines.push(chalk.gray("  ═══════════════════════════════════════════════════"));
  lines.push("");
  lines.push(`  Platform:    ${chalk.white(report.platform)}`);
  if (report.bundle_id) {
    lines.push(`  Bundle ID:   ${chalk.white(report.bundle_id)}`);
  }
  lines.push(`  Files:       ${chalk.white(formatCoverage(report))}`);
  if (report.source_scan_complete === false) {
    lines.push(
      chalk.yellow(
        `               Partial scan. Signals that were not found are reported as unverified, not as violations.`
      )
    );
  }
  lines.push(`  Stories:     ${chalk.white(String(report.rag_stories_used))} rejection cases referenced`);
  lines.push(`  Duration:    ${chalk.white((report.scan_duration_ms / 1000).toFixed(1) + "s")}`);
  lines.push("");

  // Outcome
  lines.push(`  Outcome:     ${outcomeDisplay(report.summary.outcome)}`);
  lines.push(`  Approval:    ${approvalBar(report.summary.estimated_approval_chance)}`);
  lines.push("");

  // Summary counts
  const counts = [
    report.summary.high_risk > 0 && chalk.red(`${report.summary.high_risk} high risk`),
    report.summary.medium_risk > 0 && chalk.yellow(`${report.summary.medium_risk} medium`),
    report.summary.low_risk > 0 && chalk.blue(`${report.summary.low_risk} low`),
    report.summary.info > 0 && chalk.gray(`${report.summary.info} info`),
  ].filter(Boolean);

  lines.push(
    `  Findings:    ${chalk.bold(String(report.summary.total_findings))} total` +
      (counts.length > 0 ? ` (${counts.join(" · ")})` : "")
  );
  lines.push("");

  if (report.features_detected.length > 0) {
    lines.push(`  Features:    ${chalk.gray(report.features_detected.join(", "))}`);
    lines.push("");
  }

  // Assessment
  if (report.summary.ai_assessment) {
    lines.push(chalk.gray("  ─────────────────────────────────────────────────"));
    lines.push(`  ${chalk.italic(report.summary.ai_assessment)}`);
    lines.push(chalk.gray("  ─────────────────────────────────────────────────"));
    lines.push("");
  }

  // Compliance checks (v2 reports only; v1 reports have no checks field)
  if (report.checks && report.checks.length > 0) {
    const groups = groupChecks(report.checks);
    lines.push(chalk.bold("  COMPLIANCE CHECKS"));
    lines.push(
      `  ${chalk.red(`${groups.failed.length} failed`)}, ` +
        `${chalk.yellow(`${groups.unverified.length} verify manually`)}, ` +
        `${chalk.green(`${groups.passed.length} passed`)}, ` +
        `${chalk.gray(`${groups.na.length} not applicable`)}`
    );
    lines.push("");

    for (const check of groups.failed) {
      lines.push(`  ${chalk.red(`✗ [${check.guideline_number}] ${check.title}`)}`);
    }
    for (const check of groups.unverified) {
      lines.push(`  ${chalk.yellow(`VERIFY: [${check.guideline_number}] ${check.title}`)}`);
    }
    if (groups.passed.length > 0) {
      const noun = groups.passed.length === 1 ? "check" : "checks";
      lines.push(
        chalk.gray(
          `  ${groups.passed.length} ${noun} passed (run with --format json for the full list)`
        )
      );
    }
    // n/a checks are intentionally omitted from terminal output.
    lines.push("");
  }

  // Findings grouped by risk level
  const findingsByRisk: Record<ReviewRiskLevel, ReviewFinding[]> = {
    high: [],
    medium: [],
    low: [],
    info: [],
  };

  for (const finding of report.findings) {
    findingsByRisk[finding.risk_level].push(finding);
  }

  for (const level of ["high", "medium", "low", "info"] as ReviewRiskLevel[]) {
    const findings = findingsByRisk[level];
    if (findings.length === 0) continue;

    for (const finding of findings) {
      const icon = RISK_ICONS[level];
      const label = RISK_LABELS[level];
      const color = RISK_COLORS[level];

      lines.push(chalk.gray("  ─────────────────────────────────────────────────"));
      lines.push(`  ${icon} ${color(label)}  Guideline ${finding.guideline_number} - ${finding.guideline_name}`);
      lines.push(chalk.gray("  ─────────────────────────────────────────────────"));
      lines.push("");
      lines.push(`  ${detectionBadge(finding)}${chalk.bold(finding.title)}`);
      lines.push(`  ${finding.description}`);
      lines.push("");
      lines.push(`  ${chalk.cyan("User Impact:")} ${finding.user_impact}`);

      if (finding.file) {
        lines.push(`  ${chalk.cyan("File:")} ${finding.file}`);
      }

      lines.push(`  ${chalk.green("Fix:")} ${finding.recommendation}`);

      if (finding.related_story_id) {
        lines.push(`  ${chalk.gray("Related case:")} ${finding.related_story_id}`);
      }

      lines.push("");
    }
  }

  if (report.findings.length === 0) {
    lines.push(chalk.green("  ✓ No significant issues found. Your app looks ready for review!"));
    lines.push("");
  }

  lines.push(chalk.gray("  ═══════════════════════════════════════════════════"));
  if (report.ai_review_ran === false) {
    lines.push(chalk.yellow(`  ${STATIC_ONLY_BANNER}`));
  }
  const footer = versionFooter(report);
  if (footer) {
    lines.push(chalk.gray(`  ${footer}`));
  }
  lines.push(chalk.gray("  Powered by Forvibe CLI (forvibe.app)"));
  lines.push("");

  return lines.join("\n");
}

export function formatJSON(report: CodeReviewReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatMarkdown(report: CodeReviewReport): string {
  const lines: string[] = [];

  lines.push("# App Store Review Simulation Report");
  lines.push("");
  lines.push(`**Platform:** ${report.platform}`);
  if (report.bundle_id) {
    lines.push(`**Bundle ID:** ${report.bundle_id}`);
  }
  lines.push(`**Files Analyzed:** ${formatCoverage(report)}`);
  if (report.source_scan_complete === false) {
    lines.push(
      "> Partial scan. Signals that were not found are reported as unverified, not as violations."
    );
  }
  lines.push(`**Rejection Cases Referenced:** ${report.rag_stories_used}`);
  lines.push(`**Scan Duration:** ${(report.scan_duration_ms / 1000).toFixed(1)}s`);
  lines.push("");

  if (report.ai_review_ran === false) {
    lines.push(`> ${STATIC_ONLY_BANNER}`);
    lines.push("");
  }

  lines.push("## Result");
  lines.push("");
  lines.push(`**Outcome:** ${report.summary.outcome.replace(/-/g, " ").toUpperCase()}`);
  lines.push(`**Estimated Approval Chance:** ${report.summary.estimated_approval_chance}%`);
  lines.push("");

  lines.push(`| Risk Level | Count |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| High | ${report.summary.high_risk} |`);
  lines.push(`| Medium | ${report.summary.medium_risk} |`);
  lines.push(`| Low | ${report.summary.low_risk} |`);
  lines.push(`| Info | ${report.summary.info} |`);
  lines.push(`| **Total** | **${report.summary.total_findings}** |`);
  lines.push("");

  if (report.summary.ai_assessment) {
    lines.push(`> ${report.summary.ai_assessment}`);
    lines.push("");
  }

  // Compliance checks (v2 reports only)
  if (report.checks && report.checks.length > 0) {
    const groups = groupChecks(report.checks);
    lines.push("## Compliance Checks");
    lines.push("");
    lines.push(
      `${groups.failed.length} failed, ${groups.unverified.length} verify manually, ` +
        `${groups.passed.length} passed, ${groups.na.length} not applicable`
    );
    lines.push("");
    for (const check of groups.failed) {
      lines.push(`- FAILED: [${check.guideline_number}] ${check.title}`);
    }
    for (const check of groups.unverified) {
      lines.push(`- VERIFY: [${check.guideline_number}] ${check.title}`);
    }
    if (groups.passed.length > 0) {
      const noun = groups.passed.length === 1 ? "check" : "checks";
      lines.push(`- ${groups.passed.length} ${noun} passed (run with \`--format json\` for the full list)`);
    }
    lines.push("");
  }

  if (report.features_detected.length > 0) {
    lines.push("## Detected Features");
    lines.push("");
    for (const feature of report.features_detected) {
      lines.push(`- ${feature}`);
    }
    lines.push("");
  }

  lines.push("## Findings");
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("No significant issues found. Your app looks ready for review!");
    lines.push("");
    appendMarkdownFooter(lines, report);
    return lines.join("\n");
  }

  for (const finding of report.findings) {
    const riskEmoji = RISK_ICONS[finding.risk_level];
    const badge = finding.detection === "static" ? "[static] " : finding.detection === "ai" ? "[AI] " : "";
    lines.push(`### ${riskEmoji} ${badge}${finding.title}`);
    lines.push("");
    lines.push(`**Guideline:** ${finding.guideline_number} - ${finding.guideline_name}`);
    lines.push(`**Risk Level:** ${finding.risk_level}`);
    lines.push(`**Category:** ${finding.category}`);
    lines.push("");
    lines.push(finding.description);
    lines.push("");
    lines.push(`**User Impact:** ${finding.user_impact}`);
    lines.push("");
    if (finding.file) {
      lines.push(`**File:** \`${finding.file}\``);
      lines.push("");
    }
    lines.push(`**Recommendation:** ${finding.recommendation}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  appendMarkdownFooter(lines, report);

  return lines.join("\n");
}

function appendMarkdownFooter(lines: string[], report: CodeReviewReport): void {
  const footer = versionFooter(report);
  if (footer) {
    lines.push(`*${footer}*`);
    lines.push("");
  }
  lines.push("*Powered by Forvibe CLI (forvibe.app)*");
  lines.push("");
}
