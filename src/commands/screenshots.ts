import chalk from "chalk";
import ora from "ora";
import { detectTechStack } from "../analyzers/tech-detector.js";
import { parseConfig } from "../analyzers/config-parser.js";
import { extractBranding } from "../analyzers/branding.js";
import { detectFonts } from "../analyzers/font-detector.js";
import { readReadme, readSourceCode, generateProjectTree } from "../analyzers/source-reader.js";
import { scanAppAssets } from "../analyzers/asset-scanner.js";
import { generateScreenshotBrief } from "../ai/screenshot-brief-generator.js";
import { uploadAssetsToStorage } from "./upload-assets.js";
import { getCliVersion } from "../utils/version.js";
import { ForvibeClient } from "../api/forvibe-client.js";
import { chooseProvider, connectWithCode } from "./connect.js";
import type { AIProvider } from "../ai/providers.js";

/**
 * Screenshot Studio Autopilot. Runs when the connection code was generated in
 * Screenshot Studio: no store questions, only what the screenshot plan needs.
 */
export async function runScreenshotsFlow(options: { client: ForvibeClient; provider: AIProvider; rootDir: string }) {
  const { client, provider, rootDir } = options;
  console.log(chalk.white("  Screenshot Studio: reading your app to plan store screenshots.\n"));

  const scan = ora({ text: "Detecting tech stack...", prefixText: "  " }).start();
  const techStack = detectTechStack(rootDir);
  if (techStack.stack === "unknown") {
    scan.fail(chalk.red("No supported project found. Run the CLI in your app's folder (Swift, Flutter, React Native, Expo, Kotlin, Capacitor, .NET MAUI)."));
    process.exit(1);
  }
  scan.succeed(`Tech stack: ${chalk.bold(techStack.label)} ${chalk.gray(`(${techStack.platforms.join(", ")})`)}`);

  const brandSpinner = ora({ text: "Reading config, brand colors, and fonts...", prefixText: "  " }).start();
  const config = parseConfig(rootDir, techStack.stack);
  const branding = extractBranding(rootDir, techStack.stack);
  const detectedFonts = detectFonts(rootDir, techStack.stack);
  brandSpinner.succeed(
    `Brand: ${chalk.gray([
      config.app_name,
      branding.primary_color && `primary ${branding.primary_color}`,
      branding.app_icon_path ? "icon found" : "no icon",
      detectedFonts.length > 0 && detectedFonts.join(", "),
    ].filter(Boolean).join(" · "))}`
  );

  const assetSpinner = ora({ text: "Looking for app screenshots in the repo...", prefixText: "  " }).start();
  const screenshots = scanAppAssets(rootDir, techStack.stack).filter((asset) => asset.asset_type === "screenshot");
  assetSpinner.succeed(
    screenshots.length > 0
      ? `Screenshots: ${chalk.bold(String(screenshots.length))} found`
      : `Screenshots: ${chalk.gray("none found. You can upload them in Screenshot Studio.")}`
  );

  const sourceSpinner = ora({ text: "Reading source code...", prefixText: "  " }).start();
  const readmeContent = readReadme(rootDir);
  const sourceCode = readSourceCode(rootDir, techStack.stack);
  const projectTree = generateProjectTree(rootDir);
  sourceSpinner.succeed(`Source code: ${chalk.bold(String(sourceCode.split("\n").length))} lines ${readmeContent ? chalk.gray("(README found)") : ""}`);

  console.log();
  const aiSpinner = ora({
    text: `Finding features and brand style with ${provider.name} (your source code never leaves your machine)...`,
    prefixText: "  ",
  }).start();
  let brief;
  try {
    brief = await generateScreenshotBrief(
      { techStack, config, branding, detectedFonts, readmeContent, sourceCode, projectTree, screenshotCount: screenshots.length },
      provider
    );
    aiSpinner.succeed(chalk.green(`Brief ready: ${brief.features.length} features`));
  } catch (error) {
    aiSpinner.fail(chalk.red(`AI analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`));
    process.exit(1);
  }

  for (const feature of brief.features) {
    console.log(chalk.gray(`    • ${feature.name}${feature.description ? ` — ${feature.description}` : ""}`));
  }
  console.log();

  let appAssets: Awaited<ReturnType<typeof uploadAssetsToStorage>> = [];
  if (screenshots.length > 0 || branding.app_icon_path) {
    const uploadSpinner = ora({ text: "Uploading app icon and screenshots...", prefixText: "  " }).start();
    try {
      appAssets = await uploadAssetsToStorage(client, rootDir, screenshots, branding.app_icon_path);
      uploadSpinner.succeed(`Uploaded ${appAssets.length} image${appAssets.length === 1 ? "" : "s"}`);
    } catch (error) {
      // Images are optional: the plan still works, and screens can be added in the studio.
      uploadSpinner.warn(chalk.yellow(`Images were not uploaded: ${error instanceof Error ? error.message : "Unknown error"}`));
    }
  }

  const sendSpinner = ora({ text: "Sending the brief to Screenshot Studio...", prefixText: "  " }).start();
  try {
    const result = await client.submitScreenshotBrief({
      ...brief,
      app_assets: appAssets.length > 0 ? appAssets : undefined,
      cli_version: getCliVersion(),
    });
    sendSpinner.succeed(chalk.green("Brief sent! Forvibe is planning your screenshots."));
    console.log();
    console.log(chalk.bold("  🌐 Review the plan at: ") + chalk.cyan.underline(result.web_url));
    console.log();
  } catch (error) {
    sendSpinner.fail(chalk.red(error instanceof Error ? error.message : "Could not send the brief"));
    process.exit(1);
  }
}

/**
 * `forvibe screenshots`: connects with a code generated in Screenshot Studio
 * (Continue with Autopilot) and sends the brief. Store listing or review codes
 * are refused by the server without being consumed.
 */
export async function screenshotsCommand(options: { dir?: string; apiUrl?: string }) {
  const rootDir = options.dir || process.cwd();

  console.log();
  console.log(chalk.bold("  Forvibe CLI") + chalk.gray(" — Screenshot Studio"));
  console.log();

  const provider = await chooseProvider();
  const client = new ForvibeClient(options.apiUrl);
  await connectWithCode(client, "screenshots");
  await runScreenshotsFlow({ client, provider, rootDir });
}
