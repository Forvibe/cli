import { createInterface } from "readline";
import chalk from "chalk";
import ora from "ora";
import { detectTechStack } from "../analyzers/tech-detector.js";
import { parseConfig } from "../analyzers/config-parser.js";
import { scanSDKs } from "../analyzers/sdk-scanner.js";
import { extractBranding } from "../analyzers/branding.js";
import { readReadme, readSourceCode, generateProjectTree } from "../analyzers/source-reader.js";
import { scanAppAssets } from "../analyzers/asset-scanner.js";
import { generateReport } from "../ai/report-generator.js";
import { generateASOContent } from "../ai/aso-generator.js";
import { ForvibeClient } from "../api/forvibe-client.js";

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

export async function analyzeCommand(options: { dir?: string; apiUrl?: string }) {
  const rootDir = options.dir || process.cwd();

  console.log();
  console.log(
    chalk.bold("  Forvibe CLI") + chalk.gray(" — AI-powered App Store automation")
  );
  console.log();

  // Step 1: Ask for OTC code
  const otcCode = await askQuestion(
    chalk.cyan("  🔗 Enter your Forvibe connection code: ")
  );

  if (!otcCode || otcCode.length < 6) {
    console.log(
      chalk.red("\n  ✗ Invalid code. Please enter the 6-character code from forvibe.app\n")
    );
    process.exit(1);
  }

  // Step 2: Validate OTC
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

  console.log();

  // Step 3: Detect tech stack
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

  // Step 4: Parse config
  const configSpinner = ora({
    text: "Reading project configuration...",
    prefixText: "  ",
  }).start();

  const config = parseConfig(rootDir, techStack.stack);
  const configDetails = [
    config.bundle_id && `Bundle ID: ${config.bundle_id}`,
    config.app_name && `Name: ${config.app_name}`,
    config.version && `v${config.version}`,
  ]
    .filter(Boolean)
    .join(" · ");

  configSpinner.succeed(
    `Config parsed: ${chalk.gray(configDetails || "partial data")}`
  );

  // Step 5: Scan SDKs
  const sdkSpinner = ora({
    text: "Scanning dependencies...",
    prefixText: "  ",
  }).start();

  const sdkScan = scanSDKs(rootDir, techStack.stack);
  sdkSpinner.succeed(
    `Dependencies: ${chalk.bold(String(sdkScan.detected_sdks.length))} known SDKs detected`
  );

  // Step 6: Extract branding
  const brandingSpinner = ora({
    text: "Extracting branding...",
    prefixText: "  ",
  }).start();

  const branding = extractBranding(rootDir, techStack.stack);
  const brandingDetails = [
    branding.primary_color && `Primary: ${branding.primary_color}`,
    branding.app_icon_path && "Icon found",
  ]
    .filter(Boolean)
    .join(" · ");

  brandingSpinner.succeed(
    `Branding: ${chalk.gray(brandingDetails || "no colors/icon detected")}`
  );

  // Step 7: Scan app assets (screenshots, splash, feature graphic)
  const assetSpinner = ora({
    text: "Scanning app assets...",
    prefixText: "  ",
  }).start();

  const appAssets = scanAppAssets(rootDir, techStack.stack);
  const assetParts = [
    appAssets.filter((a) => a.asset_type === "screenshot").length > 0 &&
      `${appAssets.filter((a) => a.asset_type === "screenshot").length} screenshots`,
    appAssets.some((a) => a.asset_type === "splash_screen") && "splash screen",
    appAssets.some((a) => a.asset_type === "feature_graphic") && "feature graphic",
    appAssets.some((a) => a.asset_type === "promotional_image") && "promo image",
  ].filter(Boolean);

  assetSpinner.succeed(
    `Assets: ${assetParts.length > 0 ? assetParts.join(", ") : "none found"} ${chalk.gray(`(${appAssets.length} total)`)}`
  );

  // Step 8: Read source code and project structure
  const sourceSpinner = ora({
    text: "Reading source code & project structure...",
    prefixText: "  ",
  }).start();

  const readmeContent = readReadme(rootDir);
  const sourceCode = readSourceCode(rootDir, techStack.stack);
  const projectTree = generateProjectTree(rootDir);
  const sourceLines = sourceCode.split("\n").length;

  sourceSpinner.succeed(
    `Source code: ${chalk.bold(String(sourceLines))} lines analyzed ${readmeContent ? chalk.gray("(README found)") : ""}`
  );

  console.log();

  // Step 8: Generate AI report
  const aiSpinner = ora({
    text: "AI is analyzing your project...",
    prefixText: "  ",
  }).start();

  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!geminiApiKey) {
    aiSpinner.fail(
      chalk.red(
        "GEMINI_API_KEY environment variable is required. Get one at https://aistudio.google.com/apikey"
      )
    );
    process.exit(1);
  }

  let report;
  try {
    report = await generateReport(
      {
        techStack,
        config,
        sdkScan,
        branding,
        readmeContent,
        sourceCode,
        projectTree,
      },
      geminiApiKey
    );
    // Attach scanned assets to the report
    if (appAssets.length > 0) {
      report.app_assets = appAssets;
    }

    aiSpinner.succeed(chalk.green("Analysis complete!"));
  } catch (error) {
    aiSpinner.fail(
      chalk.red(
        `AI analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`
      )
    );
    process.exit(1);
  }

  // Step 10: Generate ASO content
  const asoSpinner = ora({
    text: "Generating ASO-optimized store listing...",
    prefixText: "  ",
  }).start();

  try {
    const asoContent = await generateASOContent(report, geminiApiKey);
    report.aso_content = asoContent;
    asoSpinner.succeed(chalk.green("Store listing content generated!"));
  } catch (error) {
    asoSpinner.warn(
      chalk.yellow(
        `ASO generation skipped: ${error instanceof Error ? error.message : "Unknown error"}`
      )
    );
  }

  console.log();

  // Print summary
  console.log(chalk.bold("  📋 Report Summary"));
  console.log(chalk.gray("  ─────────────────────────────────────"));
  console.log(`  App Name:     ${chalk.white(report.app_name)}`);
  console.log(`  Bundle ID:    ${chalk.white(report.bundle_id)}`);
  console.log(`  Type:         ${chalk.white(report.app_type)}`);
  console.log(`  Category:     ${chalk.white(report.app_category_suggestion)}`);

  // Show description (wrap long descriptions)
  if (report.description) {
    const descPreview = report.description.length > 200
      ? report.description.substring(0, 200).replace(/\n/g, " ") + "..."
      : report.description.replace(/\n/g, " ");
    console.log(`  Description:  ${chalk.white(descPreview)}`);
  }

  console.log(`  Features:     ${chalk.white(report.key_features.slice(0, 3).join(", "))}${report.key_features.length > 3 ? chalk.gray(` +${report.key_features.length - 3} more`) : ""}`);
  console.log(`  Audience:     ${chalk.white(report.target_audience.length > 100 ? report.target_audience.substring(0, 100) + "..." : report.target_audience)}`);
  console.log(`  SDKs:         ${chalk.white(String(report.detected_sdks.length))} detected`);
  console.log(`  Data:         ${chalk.white(report.data_collected.join(", ") || "none")}`);
  console.log(`  Colors:       ${chalk.hex(report.primary_color)("■")} ${report.primary_color} ${report.secondary_color ? `${chalk.hex(report.secondary_color)("■")} ${report.secondary_color}` : ""}`);
  console.log(`  Icon:         ${report.app_icon_base64 ? chalk.green("✓ found") : chalk.gray("not found")}`);
  console.log(`  Assets:       ${report.app_assets?.length ? chalk.green(`${report.app_assets.length} found`) : chalk.gray("none")}`);
  console.log(chalk.gray("  ─────────────────────────────────────"));

  // Print ASO preview
  if (report.aso_content) {
    console.log();
    console.log(chalk.bold("  📱 App Store Listing Preview"));
    console.log(chalk.gray("  ─────────────────────────────────────"));

    const aso = report.aso_content.appstore;
    console.log(`  Title:       ${chalk.white(aso.app_name)} ${chalk.gray(`(${aso.app_name.length}/30)`)}`);
    console.log(`  Subtitle:    ${chalk.white(aso.subtitle)} ${chalk.gray(`(${aso.subtitle.length}/30)`)}`);
    console.log(`  Keywords:    ${chalk.white(aso.keywords)} ${chalk.gray(`(${aso.keywords.length}/100)`)}`);
    console.log(`  Promo:       ${chalk.white(aso.promotional_text)} ${chalk.gray(`(${aso.promotional_text.length}/170)`)}`);

    const descPreview = aso.description.substring(0, 150).replace(/\n/g, " ");
    console.log(`  Description: ${chalk.white(descPreview)}${aso.description.length > 150 ? chalk.gray("...") : ""} ${chalk.gray(`(${aso.description.length}/4000)`)}`);

    if (report.aso_content.playstore) {
      console.log();
      console.log(chalk.bold("  🤖 Play Store Listing Preview"));
      console.log(chalk.gray("  ─────────────────────────────────────"));
      const ps = report.aso_content.playstore;
      console.log(`  Title:       ${chalk.white(ps.title)} ${chalk.gray(`(${ps.title.length}/30)`)}`);
      console.log(`  Short Desc:  ${chalk.white(ps.short_description)} ${chalk.gray(`(${ps.short_description.length}/80)`)}`);

      const psDescPreview = ps.description.substring(0, 150).replace(/\n/g, " ");
      console.log(`  Description: ${chalk.white(psDescPreview)}${ps.description.length > 150 ? chalk.gray("...") : ""} ${chalk.gray(`(${ps.description.length}/4000)`)}`);
    }

    console.log(chalk.gray("  ─────────────────────────────────────"));
  }

  console.log();

  // Step 10: Send report
  const sendSpinner = ora({
    text: "Sending report to Forvibe...",
    prefixText: "  ",
  }).start();

  try {
    const result = await client.submitReport(report);
    sendSpinner.succeed(chalk.green("Report sent successfully!"));

    console.log();
    console.log(
      chalk.bold("  🌐 Continue setup at: ") +
        chalk.cyan.underline(result.web_url)
    );
    console.log();
  } catch (error) {
    sendSpinner.fail(
      chalk.red(
        `Failed to send report: ${error instanceof Error ? error.message : "Unknown error"}`
      )
    );
    process.exit(1);
  }
}
