// `forvibe review` v2: hybrid static + AI pipeline.
//
// Order: detect stack -> parse config -> load rulepack (remote->cache->bundled)
// -> read source -> run static rule engine -> THEN pick an AI provider. The
// static path needs no network and no API key; when no provider is available
// (or --static-only is set) the command still produces a full static report
// instead of exiting. When the AI pass runs, the assembled context is redacted
// (redactSecrets) BEFORE any provider call, and the final summary is always
// the deterministic formula over merged findings (see report-builder.ts).

import { createInterface } from "readline";
import chalk from "chalk";
import ora from "ora";
import { detectTechStack } from "../analyzers/tech-detector.js";
import { parseConfig } from "../analyzers/config-parser.js";
import {
  readSourceFiles,
  joinSourceFiles,
  generateProjectTree,
} from "../analyzers/source-reader.js";
import { ForvibeClient } from "../api/forvibe-client.js";
import { getAvailableProviders, type AIProvider } from "../ai/providers.js";
import { runStaticEngine } from "../engine/index.js";
import { loadRulepackBundle } from "../engine/remote.js";
import { redactSecrets } from "../engine/redactor.js";
import type { ProfileSDK } from "../engine/types.js";
import { runCodeReview } from "../review/reviewer.js";
import { assembleReportV2 } from "../review/report-builder.js";
import { formatTerminal, formatJSON, formatMarkdown } from "../review/formatters.js";
import { getCliVersion } from "../utils/version.js";
import type { CodeReviewReport, ReviewFormat } from "../types/review.js";

// Mirrors DEFAULT_API_URL in src/api/forvibe-client.ts: the rulepack endpoint
// lives on the same host as the rest of the Forvibe API.
const DEFAULT_RULEPACK_BASE_URL = "https://forvibe.app";

function askQuestion(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function reviewCommand(options: {
  dir?: string;
  deep?: boolean;
  format?: string;
  send?: boolean;
  apiUrl?: string;
  rulepackUrl?: string;
  staticOnly?: boolean;
}) {
  const rootDir = options.dir || process.cwd();
  const deep = options.deep ?? false;
  const staticOnly = options.staticOnly ?? false;
  const format = (options.format || "terminal") as ReviewFormat;
  const startTime = Date.now();

  console.log();
  console.log(
    chalk.bold("  Forvibe CLI") +
      chalk.gray(" - App Store Review Simulation") +
      (deep ? chalk.cyan(" [DEEP MODE]") : "") +
      (staticOnly ? chalk.cyan(" [STATIC ONLY]") : "")
  );
  console.log();

  // Step 1: Detect tech stack
  const techSpinner = ora({
    text: "Detecting tech stack...",
    prefixText: "  ",
  }).start();

  const techStack = detectTechStack(rootDir);

  if (techStack.stack === "unknown") {
    techSpinner.fail(
      chalk.red(
        "No supported project found. Supported: Swift, Objective-C, Flutter, React Native, Kotlin, Kotlin Multiplatform, Capacitor, .NET MAUI, Unity"
      )
    );
    process.exit(1);
  }

  techSpinner.succeed(
    `Tech stack: ${chalk.bold(techStack.label)} ${chalk.gray(`(${techStack.platforms.join(", ")})`)}`
  );

  // Step 2: Parse config
  const configSpinner = ora({
    text: "Reading project configuration...",
    prefixText: "  ",
  }).start();

  const config = parseConfig(rootDir, techStack.stack);
  const appName = config.app_name || "Unknown App";
  const bundleId = config.bundle_id || "";

  configSpinner.succeed(
    `Config: ${chalk.white(appName)} ${bundleId ? chalk.gray(`(${bundleId})`) : ""}`
  );

  // Step 3: Load rulepack (remote -> cache -> bundled; never blocks on network)
  const rulepackSpinner = ora({
    text: "Loading review rulepack...",
    prefixText: "  ",
  }).start();

  const rulepackBaseUrl =
    options.rulepackUrl || options.apiUrl || DEFAULT_RULEPACK_BASE_URL;

  let loadedRulepack;
  try {
    loadedRulepack = await loadRulepackBundle({ baseUrl: rulepackBaseUrl });
  } catch (error) {
    // Only reachable when even the bundled snapshot is unreadable (broken install).
    rulepackSpinner.fail(
      chalk.red(error instanceof Error ? error.message : "Failed to load rulepack")
    );
    process.exit(1);
  }
  const { bundle } = loadedRulepack;

  rulepackSpinner.succeed(
    `Rulepack ${chalk.bold(`v${loadedRulepack.version}`)} ${chalk.gray(`(${loadedRulepack.source})`)}`
  );

  // Step 4: Read source code + project tree
  const sourceSpinner = ora({
    text: "Reading source code...",
    prefixText: "  ",
  }).start();

  // Use large context for review - read as much code as possible
  const maxChars = deep ? 400000 : 150000;
  const sourceFiles = readSourceFiles(rootDir, techStack.stack, maxChars);
  const sourceCode = joinSourceFiles(sourceFiles);
  const projectTree = generateProjectTree(rootDir);
  const sourceLines = sourceCode.split("\n").length;

  sourceSpinner.succeed(
    `Source code: ${chalk.bold(String(sourceLines))} lines in ${chalk.bold(String(sourceFiles.length))} files`
  );

  // Step 5: Static rule engine (deterministic; no network, no AI)
  const staticSpinner = ora({
    text: "Running static rule engine...",
    prefixText: "  ",
  }).start();

  // Pass the exact same files the AI prompt will see, so behavioral signals
  // are scanned over the same corpus.
  const staticResult = runStaticEngine({
    rootDir,
    stackResult: techStack,
    appConfig: {
      app_name: config.app_name,
      bundle_id: config.bundle_id,
      version: config.version,
      min_ios_version: config.min_ios_version,
      min_android_sdk: config.min_android_sdk,
    },
    bundle,
    sourceFiles,
  });

  const checkCount = (status: string) =>
    staticResult.checks.filter((c) => c.status === status).length;
  staticSpinner.succeed(
    `Static scan: ${chalk.red(`${checkCount("fail")} failed`)}, ` +
      `${chalk.yellow(`${checkCount("unverified")} unverified`)}, ` +
      `${chalk.green(`${checkCount("pass")} passed`)}, ` +
      `${chalk.gray(`${checkCount("na")} n/a`)}`
  );

  // Step 6: Provider selection (AFTER the static pass: a missing API key no
  // longer aborts the command; it just skips the AI behavioral review).
  let provider: AIProvider | null = null;

  if (!staticOnly) {
    const availableProviders = getAvailableProviders(deep);

    if (availableProviders.length === 0) {
      console.log();
      console.log(
        chalk.yellow(
          "  No AI API key found. AI behavioral review skipped. Static rule results below."
        )
      );
      console.log(chalk.gray("  To enable the AI review pass, set one of the following:"));
      console.log(
        chalk.cyan("    export ANTHROPIC_API_KEY=your-key") +
          chalk.gray("   https://console.anthropic.com/settings/keys") +
          chalk.green(" (recommended)")
      );
      console.log(
        chalk.cyan("    export OPENAI_API_KEY=your-key") +
          chalk.gray("      https://platform.openai.com/api-keys")
      );
      console.log(
        chalk.cyan("    export GEMINI_API_KEY=your-key") +
          chalk.gray("       https://aistudio.google.com/apikey")
      );
      console.log();
    } else if (availableProviders.length === 1) {
      provider = availableProviders[0].create();
    } else {
      console.log();
      console.log(chalk.white("  Multiple AI API keys detected. Choose a provider:\n"));
      availableProviders.forEach((p, i) => {
        const label = `${i + 1}. ${p.name}${p.recommended ? chalk.green(" (recommended)") : ""}`;
        console.log(`    ${label}`);
      });
      console.log();

      const answer = await askQuestion(
        chalk.cyan(`  Enter choice (1-${availableProviders.length}): `)
      );
      const index = parseInt(answer, 10) - 1;

      if (isNaN(index) || index < 0 || index >= availableProviders.length) {
        const recommended =
          availableProviders.find((p) => p.recommended) || availableProviders[0];
        provider = recommended.create();
        console.log(chalk.gray(`  Using ${recommended.name} (default)\n`));
      } else {
        provider = availableProviders[index].create();
      }
    }

    if (provider) {
      console.log(chalk.gray(`  AI Provider: ${provider.name} ✓`));
      console.log();
    }
  }

  let report: CodeReviewReport;

  if (!provider) {
    // Static-only path (--static-only flag or no API key). No network beyond
    // the rulepack attempt above, no AI. features_detected stays [] here:
    // that field is reserved for AI pass-1 discoveries; static capabilities
    // live in app_profile.capabilities.
    report = assembleReportV2({
      platform: techStack.label,
      bundleId: config.bundle_id,
      sourceFilesAnalyzed: sourceFiles.length,
      featuresDetected: [],
      staticFindings: staticResult.findings,
      aiFindings: [],
      checks: staticResult.checks,
      profile: staticResult.profile,
      rulepack: {
        version: loadedRulepack.version,
        store: bundle.store,
        source: loadedRulepack.source,
      },
      engineVersion: getCliVersion(),
      aiReviewRan: false,
      ragStoriesUsed: 0,
      scanDurationMs: Date.now() - startTime,
    });
  } else {
    // Hybrid path: static results + AI behavioral review.

    // Build the enriched context, then redact secrets BEFORE anything is sent
    // to the AI provider. One pass over the fully assembled context covers the
    // tree, the SDK list, and every source file.
    const enrichedSource = buildEnrichedContext(
      sourceCode,
      projectTree,
      staticResult.profile.sdks
    );
    const { text: redactedSource, redactedCount } = redactSecrets(enrichedSource);
    if (redactedCount > 0) {
      console.log(
        chalk.yellow(
          `  Redacted ${redactedCount} secret-like values before sending source to the AI provider.`
        )
      );
      console.log();
    }

    const reviewSpinner = ora({
      text: deep
        ? `Running deep review with ${provider.name} (Pass 1: feature detection, Pass 2: Apple reviewer simulation)...`
        : `Running review with ${provider.name} (simulating Apple's review process)...`,
      prefixText: "  ",
    }).start();

    try {
      const aiResult = await runCodeReview({
        provider,
        platform: techStack.label,
        appName,
        bundleId,
        sourceContext: redactedSource,
        deep,
        profile: staticResult.profile,
        staticChecks: staticResult.checks,
        staticFindings: staticResult.findings,
        bundle,
      });

      report = assembleReportV2({
        platform: techStack.label,
        bundleId: config.bundle_id,
        sourceFilesAnalyzed: sourceFiles.length,
        featuresDetected: aiResult.featuresDetected,
        staticFindings: aiResult.staticFindings,
        aiFindings: aiResult.aiFindings,
        checks: aiResult.checks,
        profile: aiResult.profile,
        rulepack: {
          version: loadedRulepack.version,
          store: bundle.store,
          source: loadedRulepack.source,
        },
        engineVersion: getCliVersion(),
        aiReviewRan: true,
        aiAssessment: aiResult.aiAssessment,
        ragStoriesUsed: aiResult.ragStoriesUsed,
        scanDurationMs: Date.now() - startTime,
      });

      reviewSpinner.succeed(
        chalk.green(
          `Review complete! ${report.summary.total_findings} findings (${report.summary.high_risk} high risk)`
        )
      );

      if (aiResult.dedupedCount > 0) {
        console.log(
          chalk.gray(
            `  Deduplicated ${aiResult.dedupedCount} findings already covered by static analysis.`
          )
        );
      }
    } catch (error) {
      reviewSpinner.fail(
        chalk.red(
          `Review failed: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      );
      process.exit(1);
    }
  }

  // Step 7: Output report
  switch (format) {
    case "json":
      console.log(formatJSON(report));
      break;
    case "markdown":
      console.log(formatMarkdown(report));
      break;
    case "terminal":
    default:
      console.log(formatTerminal(report));
      break;
  }

  // Step 8: Optionally send to Forvibe
  if (options.send) {
    console.log(
      chalk.gray("  ─────────────────────────────────────────────────")
    );
    console.log();

    const otcCode = await askQuestion(
      chalk.cyan("  🔗 Enter your Forvibe connection code: ")
    );

    if (!otcCode || otcCode.length < 6) {
      console.log(
        chalk.red(
          "\n  ✗ Invalid code. Please enter the 6-character code from forvibe.app\n"
        )
      );
      process.exit(1);
    }

    const connectSpinner = ora({
      text: "Connecting to Forvibe...",
      prefixText: "  ",
    }).start();

    const client = new ForvibeClient(options.apiUrl);

    try {
      await client.validateOTC(otcCode);
      connectSpinner.succeed(chalk.green("Connected to Forvibe!"));
    } catch (error) {
      connectSpinner.fail(
        chalk.red(error instanceof Error ? error.message : "Connection failed")
      );
      process.exit(1);
    }

    const sendSpinner = ora({
      text: "Sending review results to Forvibe...",
      prefixText: "  ",
    }).start();

    try {
      const result = await client.submitCodebaseReview(report);
      sendSpinner.succeed(chalk.green("Review results sent!"));
      console.log();
      console.log(
        chalk.bold("  🌐 View combined review at: ") +
          chalk.cyan.underline(result.web_url)
      );
      console.log();
    } catch (error) {
      sendSpinner.fail(
        chalk.red(
          `Failed to send: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      );
    }
  }
}

// Enriched AI context: project tree + detected SDK list + source corpus. The
// SDK list comes from the static engine's profile (registry-matched, includes
// data_collection facts) - the single source of truth - instead of the legacy
// scanSDKs analyzer output.
function buildEnrichedContext(
  sourceCode: string,
  projectTree: string,
  sdks: ProfileSDK[]
): string {
  const sections: string[] = [];

  // Project tree for structure understanding
  sections.push(`## Project Structure\n\`\`\`\n${projectTree}\n\`\`\``);

  // SDK information for privacy/compliance context
  if (sdks.length > 0) {
    const sdkList = sdks
      .map(
        (sdk) =>
          `- ${sdk.name} (${sdk.category})${sdk.data_collection.length > 0 ? `, collects: ${sdk.data_collection.join(", ")}` : ""}`
      )
      .join("\n");
    sections.push(`## Detected SDKs\n${sdkList}`);
  }

  // Source code
  sections.push(`## Source Code\n\n${sourceCode}`);

  return sections.join("\n\n");
}
