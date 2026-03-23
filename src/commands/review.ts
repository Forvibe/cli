import { createInterface } from "readline";
import chalk from "chalk";
import ora from "ora";
import { detectTechStack } from "../analyzers/tech-detector.js";
import { parseConfig } from "../analyzers/config-parser.js";
import { scanSDKs } from "../analyzers/sdk-scanner.js";
import { readSourceCode, generateProjectTree } from "../analyzers/source-reader.js";
import { ForvibeClient } from "../api/forvibe-client.js";
import { getAvailableProviders } from "../ai/providers.js";
import { runCodeReview } from "../review/reviewer.js";
import { formatTerminal, formatJSON, formatMarkdown } from "../review/formatters.js";
import type { ReviewFormat } from "../types/review.js";

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
}) {
  const rootDir = options.dir || process.cwd();
  const deep = options.deep ?? false;
  const format = (options.format || "terminal") as ReviewFormat;

  console.log();
  console.log(
    chalk.bold("  Forvibe CLI") +
      chalk.gray(" — App Store Review Simulation") +
      (deep ? chalk.cyan(" [DEEP MODE]") : "")
  );
  console.log();

  // Step 0: Detect AI provider
  const availableProviders = getAvailableProviders(deep);

  if (availableProviders.length === 0) {
    console.log(chalk.red("  ✗ No AI API key found. Set one of the following:\n"));
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
    console.log(
      chalk.gray("  Your source code is analyzed locally — it never leaves your machine.\n")
    );
    process.exit(1);
  }

  let provider;

  if (availableProviders.length === 1) {
    provider = availableProviders[0].create();
  } else {
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

  console.log(chalk.gray(`  AI Provider: ${provider.name} ✓`));
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
        "No supported project found. Supported: Swift, Flutter, React Native, Kotlin, Capacitor, .NET MAUI"
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

  // Step 3: Scan SDKs (used for context)
  const sdkSpinner = ora({
    text: "Scanning dependencies...",
    prefixText: "  ",
  }).start();

  const sdkScan = scanSDKs(rootDir, techStack.stack);
  sdkSpinner.succeed(
    `Dependencies: ${chalk.bold(String(sdkScan.detected_sdks.length))} known SDKs detected`
  );

  // Step 4: Read source code
  const sourceSpinner = ora({
    text: "Reading source code...",
    prefixText: "  ",
  }).start();

  // Use large context for review — read as much code as possible
  const maxChars = deep ? 400000 : 150000;
  const sourceCode = readSourceCode(rootDir, techStack.stack, maxChars);
  const projectTree = generateProjectTree(rootDir);
  const sourceLines = sourceCode.split("\n").length;

  sourceSpinner.succeed(
    `Source code: ${chalk.bold(String(sourceLines))} lines analyzed`
  );

  console.log();

  // Step 5: Run AI Review
  const reviewSpinner = ora({
    text: deep
      ? `Running deep review with ${provider.name} (Pass 1: feature detection, Pass 2: Apple reviewer simulation)...`
      : `Running review with ${provider.name} (simulating Apple's review process)...`,
    prefixText: "  ",
  }).start();

  let report;

  try {
    // Build enriched source context with SDK info and project tree
    const enrichedSource = buildEnrichedContext(
      sourceCode,
      projectTree,
      sdkScan,
      config
    );

    report = await runCodeReview(
      provider,
      techStack.label,
      appName,
      bundleId,
      enrichedSource,
      sourceLines,
      deep
    );

    reviewSpinner.succeed(
      chalk.green(
        `Review complete! ${report.summary.total_findings} findings (${report.summary.high_risk} high risk)`
      )
    );
  } catch (error) {
    reviewSpinner.fail(
      chalk.red(
        `Review failed: ${error instanceof Error ? error.message : "Unknown error"}`
      )
    );
    process.exit(1);
  }

  // Step 6: Output report
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

  // Step 7: Optionally send to Forvibe
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

function buildEnrichedContext(
  sourceCode: string,
  projectTree: string,
  sdkScan: { detected_sdks: Array<{ name: string; category: string; collects: string[] }> },
  config: { app_name: string | null; bundle_id: string | null; version: string | null }
): string {
  const sections: string[] = [];

  // Project tree for structure understanding
  sections.push(`## Project Structure\n\`\`\`\n${projectTree}\n\`\`\``);

  // SDK information for privacy/compliance context
  if (sdkScan.detected_sdks.length > 0) {
    const sdkList = sdkScan.detected_sdks
      .map((sdk) => `- ${sdk.name} (${sdk.category})${sdk.collects.length > 0 ? ` — collects: ${sdk.collects.join(", ")}` : ""}`)
      .join("\n");
    sections.push(`## Detected SDKs\n${sdkList}`);
  }

  // Source code
  sections.push(`## Source Code\n\n${sourceCode}`);

  return sections.join("\n\n");
}
