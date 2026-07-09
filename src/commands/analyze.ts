import { createInterface } from "readline";
import { readFileSync, statSync } from "fs";
import { basename, extname, relative } from "path";
import chalk from "chalk";
import ora from "ora";
import { detectTechStack } from "../analyzers/tech-detector.js";
import { parseConfig } from "../analyzers/config-parser.js";
import { scanSDKs } from "../analyzers/sdk-scanner.js";
import { extractBranding } from "../analyzers/branding.js";
import { detectFonts } from "../analyzers/font-detector.js";
import { readReadme, readSourceCode, generateProjectTree } from "../analyzers/source-reader.js";
import { scanAppAssets } from "../analyzers/asset-scanner.js";
import { ForvibeClient } from "../api/forvibe-client.js";
import { getAvailableProviders } from "../ai/providers.js";
import type { CLIAppAsset } from "../types/report.js";

function mimeForPath(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function uploadAssetsToStorage(
  client: ForvibeClient,
  rootDir: string,
  assets: CLIAppAsset[],
  appIconPath: string | null
): Promise<CLIAppAsset[]> {
  // Build a parallel array of { asset metadata, binary buffer }.
  type Pending = { asset: CLIAppAsset; buffer: Buffer };
  const pending: Pending[] = [];

  for (const asset of assets) {
    if (!asset.base64_data) continue;
    pending.push({
      asset,
      buffer: Buffer.from(asset.base64_data, "base64"),
    });
  }

  // Attach app icon as a first-class asset (if present and within size cap).
  if (appIconPath) {
    try {
      const stat = statSync(appIconPath);
      if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
        const buffer = readFileSync(appIconPath);
        pending.push({
          asset: {
            asset_type: "app_icon",
            file_name: basename(appIconPath),
            mime_type: mimeForPath(appIconPath),
            width: null,
            height: null,
            source_path: relative(rootDir, appIconPath),
          },
          buffer,
        });
      }
    } catch {
      // ignore — icon upload is best-effort
    }
  }

  if (pending.length === 0) return [];

  const { uploads } = await client.getAssetUploadUrls(
    pending.map((p) => ({
      asset_type: p.asset.asset_type,
      file_name: p.asset.file_name,
      mime_type: p.asset.mime_type,
    }))
  );

  if (uploads.length !== pending.length) {
    throw new Error(
      `Upload slot count mismatch: requested ${pending.length}, got ${uploads.length}`
    );
  }

  // Parallel upload with concurrency cap of 3.
  const concurrency = 3;
  for (let i = 0; i < pending.length; i += concurrency) {
    const chunk = pending.slice(i, i + concurrency);
    const slots = uploads.slice(i, i + concurrency);
    await Promise.all(
      chunk.map((p, idx) =>
        client.uploadAssetToSignedUrl(
          slots[idx].signed_url,
          p.buffer,
          p.asset.mime_type
        )
      )
    );
  }

  // Return assets with storage refs, no base64.
  return pending.map((p, i) => ({
    asset_type: p.asset.asset_type,
    file_name: uploads[i].file_name,
    mime_type: p.asset.mime_type,
    width: p.asset.width,
    height: p.asset.height,
    source_path: p.asset.source_path,
    storage_bucket: uploads[i].bucket,
    storage_path: uploads[i].storage_path,
  }));
}

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

  // Step 0: Detect AI provider
  const availableProviders = getAvailableProviders();

  if (availableProviders.length === 0) {
    console.log(chalk.red("  ✗ No AI API key found. Set one of the following:\n"));
    console.log(chalk.cyan("    export ANTHROPIC_API_KEY=your-key") + chalk.gray("   https://console.anthropic.com/settings/keys") + chalk.green(" (recommended)"));
    console.log(chalk.cyan("    export OPENAI_API_KEY=your-key") + chalk.gray("      https://platform.openai.com/api-keys"));
    console.log(chalk.cyan("    export GEMINI_API_KEY=your-key") + chalk.gray("       https://aistudio.google.com/apikey"));
    console.log();
    console.log(chalk.gray("  Your source code is analyzed locally — it never leaves your machine.\n"));
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

    const answer = await askQuestion(chalk.cyan(`  Enter choice (1-${availableProviders.length}): `));
    const index = parseInt(answer, 10) - 1;

    if (isNaN(index) || index < 0 || index >= availableProviders.length) {
      // Default to recommended (Claude) or first
      const recommended = availableProviders.find((p) => p.recommended) || availableProviders[0];
      provider = recommended.create();
      console.log(chalk.gray(`  Using ${recommended.name} (default)\n`));
    } else {
      provider = availableProviders[index].create();
    }
  }

  console.log(chalk.gray(`  AI Provider: ${provider.name} ✓`));

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
        "No supported project found. Supported: Swift, Flutter, React Native, Expo, Kotlin, Capacitor, .NET MAUI"
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

  // Step 6b: Detect fonts
  const fontSpinner = ora({
    text: "Detecting fonts...",
    prefixText: "  ",
  }).start();

  const detectedFonts = detectFonts(rootDir, techStack.stack);
  fontSpinner.succeed(
    `Fonts: ${detectedFonts.length > 0 ? chalk.white(detectedFonts.join(", ")) : chalk.gray("none detected")}`
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

  // Step 9: AI Analysis (source code never leaves the machine)
  let report;

  const aiSpinner = ora({
    text: `Analyzing locally with ${provider.name} (your source code never leaves your machine)...`,
    prefixText: "  ",
  }).start();

  try {
    const { generateReport } = await import("../ai/report-generator.js");
    report = await generateReport(
      { techStack, config, sdkScan, branding, readmeContent, sourceCode, projectTree },
      provider
    );
    if (appAssets.length > 0) {
      report.app_assets = appAssets;
    }
    if (branding.brand_colors.length > 0) {
      report.brand_colors = branding.brand_colors;
    }
    if (detectedFonts.length > 0) {
      report.detected_fonts = detectedFonts;
    }
    aiSpinner.succeed(chalk.green("Analysis complete!"));
  } catch (error) {
    aiSpinner.fail(
      chalk.red(`AI analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`)
    );
    process.exit(1);
  }

  const asoSpinner = ora({
    text: "Generating ASO-optimized store listing...",
    prefixText: "  ",
  }).start();

  try {
    const { generateASOContent } = await import("../ai/aso-generator.js");
    const stores = client.storeConfig?.stores || [];
    const asoContent = await generateASOContent(report, provider, stores);
    report.aso_content = asoContent;
    asoSpinner.succeed(chalk.green("Store listing content generated!"));
  } catch (error) {
    asoSpinner.warn(
      chalk.yellow(`ASO generation skipped: ${error instanceof Error ? error.message : "Unknown error"}`)
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
  console.log(`  Colors:       ${chalk.hex(report.primary_color)("■")} ${report.primary_color} ${report.secondary_color ? `${chalk.hex(report.secondary_color)("■")} ${report.secondary_color}` : ""}${report.brand_colors?.length ? chalk.gray(` +${report.brand_colors.length} brand colors`) : ""}`);
  console.log(`  Fonts:        ${report.detected_fonts?.length ? chalk.white(report.detected_fonts.join(", ")) : chalk.gray("none detected")}`);
  console.log(`  Icon:         ${report.app_icon_base64 ? chalk.green("✓ found") : chalk.gray("not found")}`);
  console.log(`  Assets:       ${report.app_assets?.length ? chalk.green(`${report.app_assets.length} found`) : chalk.gray("none")}`);
  console.log(chalk.gray("  ─────────────────────────────────────"));

  // Print ASO preview
  if (report.aso_content) {
    if (report.aso_content.appstore) {
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
      console.log(chalk.gray("  ─────────────────────────────────────"));
    }

    if (report.aso_content.playstore) {
      console.log();
      console.log(chalk.bold("  🤖 Play Store Listing Preview"));
      console.log(chalk.gray("  ─────────────────────────────────────"));
      const ps = report.aso_content.playstore;
      console.log(`  Title:       ${chalk.white(ps.title)} ${chalk.gray(`(${ps.title.length}/30)`)}`);
      console.log(`  Short Desc:  ${chalk.white(ps.short_description)} ${chalk.gray(`(${ps.short_description.length}/80)`)}`);

      const psDescPreview = ps.description.substring(0, 150).replace(/\n/g, " ");
      console.log(`  Description: ${chalk.white(psDescPreview)}${ps.description.length > 150 ? chalk.gray("...") : ""} ${chalk.gray(`(${ps.description.length}/4000)`)}`);
      console.log(chalk.gray("  ─────────────────────────────────────"));
    }
  }

  // Determine selected stores from server config
  const selectedStores = client.storeConfig?.stores || [];
  const hasASC = selectedStores.includes("appstore") || selectedStores.length === 0;
  const hasPS = selectedStores.includes("playstore") || selectedStores.length === 0;

  // Step 10: App Review Information (App Store only)
  if (hasASC) {
    console.log();
    console.log(chalk.bold("  📝 App Review Information"));
    console.log(chalk.gray("  ─────────────────────────────────────"));
    console.log(chalk.gray("  Apple's review team may need to sign in to your app."));
    console.log(chalk.gray("  You can also provide this later in the Forvibe dashboard."));
    console.log();

    // Check if app has auth SDKs
    const hasAuthSDKs = (sdkScan.third_party_services.auth?.length ?? 0) > 0;

    if (hasAuthSDKs) {
      const signInAnswer = await askQuestion(
        chalk.cyan("  Does your app require sign-in to use? (y/n): ")
      );
      const signInRequired = signInAnswer.toLowerCase().startsWith("y");
      report.sign_in_required = signInRequired;

      if (signInRequired) {
        console.log();
        console.log(chalk.yellow("  ⚠ Please create a test account in your app for Apple's review team."));
        console.log(chalk.gray("  This account should have full access to your app's features."));
        console.log();

        const testEmail = await askQuestion(chalk.cyan("  Test account email: "));
        const testPassword = await askQuestion(chalk.cyan("  Test account password: "));

        if (testEmail && testPassword) {
          report.test_account = { email: testEmail, password: testPassword };
          console.log(chalk.green("  ✓ Test account saved"));
        }
      }
    } else {
      report.sign_in_required = false;
    }

    console.log();
    console.log(chalk.gray("  Contact information for Apple's review team (press Enter to skip):"));
    console.log();

    const firstName = await askQuestion(chalk.cyan("  First name: "));
    const lastName = await askQuestion(chalk.cyan("  Last name: "));
    const contactEmail = await askQuestion(chalk.cyan("  Email: "));
    const contactPhone = await askQuestion(chalk.cyan("  Phone (e.g. +1 555 123 4567): "));

    if (firstName && lastName && contactEmail) {
      report.review_contact = {
        first_name: firstName,
        last_name: lastName,
        email: contactEmail,
        phone: contactPhone || "",
      };
      console.log(chalk.green("  ✓ Contact info saved"));
    } else {
      console.log(chalk.gray("  ℹ Skipped — you can add this later in the dashboard."));
    }

    console.log(chalk.gray("  ─────────────────────────────────────"));
  }

  // Step 10b: Play Store Declarations (only if Play Store selected)
  if (hasPS) {
    console.log();
    console.log(chalk.bold("  🤖 Play Store Declarations"));
    console.log(chalk.gray("  ─────────────────────────────────────"));
    console.log(chalk.gray("  Google Play requires content declarations before publishing."));
    console.log(chalk.gray("  We'll auto-detect what we can and ask you to confirm."));
    console.log();

    // Auto-detect values from SDK scan and report
    const hasAdSDKs = (sdkScan.third_party_services.ads?.length ?? 0) > 0;
    const hasPaymentSDKs = (sdkScan.third_party_services.payment?.length ?? 0) > 0;
    const isHealthApp = report.app_type === "health";
    const isFinanceApp = report.app_type === "finance";
    const hasHealthSDKs = sdkScan.detected_sdks.some(
      (s) => s.name.toLowerCase().includes("health") || s.collects.includes("health_data")
    );
    const hasFinanceSDKs = hasPaymentSDKs || sdkScan.detected_sdks.some(
      (s) => s.name.toLowerCase().includes("billing") || s.name.toLowerCase().includes("stripe") || s.name.toLowerCase().includes("revenue")
    );

    // 1. App Access
    let appAccess: "unrestricted" | "restricted_login" | "restricted_other" = "unrestricted";
    let appAccessInstructions: string | undefined;

    if (report.sign_in_required) {
      appAccess = "restricted_login";
      if (report.test_account) {
        appAccessInstructions = `Test account: ${report.test_account.email} / ${report.test_account.password}`;
      }
      console.log(chalk.white("  App Access: ") + chalk.yellow("Restricted (login required)"));
    } else {
      const accessAnswer = await askQuestion(
        chalk.cyan("  Does your app have restricted access (login, special permissions, etc.)? (y/n): ")
      );
      if (accessAnswer.toLowerCase().startsWith("y")) {
        appAccess = "restricted_login";
        const instrAnswer = await askQuestion(
          chalk.cyan("  How can a reviewer access all features? (describe or Enter to skip): ")
        );
        if (instrAnswer) appAccessInstructions = instrAnswer;
      } else {
        console.log(chalk.green("  ✓ App is freely accessible"));
      }
    }

    // 2. Ads
    let containsAds = hasAdSDKs || report.advertising_type !== "none";
    if (containsAds) {
      console.log(chalk.white("  Ads: ") + chalk.yellow(`Detected (${sdkScan.third_party_services.ads?.join(", ") || report.advertising_type})`));
      const adsConfirm = await askQuestion(
        chalk.cyan("  Does your app contain ads? (Y/n): ")
      );
      if (adsConfirm.toLowerCase() === "n") containsAds = false;
    } else {
      const adsAnswer = await askQuestion(
        chalk.cyan("  Does your app contain ads? (y/N): ")
      );
      containsAds = adsAnswer.toLowerCase().startsWith("y");
    }
    console.log(containsAds ? chalk.yellow("  → Contains ads") : chalk.green("  ✓ No ads"));

    // 3. Target Audience
    let targetAgeGroup: "all_ages" | "older_users_only" | "mixed" = "all_ages";
    let isAppealToChildren = false;

    if (report.is_for_children) {
      console.log(chalk.yellow("  ⚠ App appears to target children"));
      targetAgeGroup = "all_ages";
      isAppealToChildren = true;
    } else {
      console.log();
      console.log(chalk.gray("  Target age groups:"));
      console.log(chalk.gray("    1. All ages (including children under 13)"));
      console.log(chalk.gray("    2. Older users only (13+ or 18+)"));
      console.log(chalk.gray("    3. Mixed (targets both children and older users)"));
      const ageAnswer = await askQuestion(chalk.cyan("  Choose target audience (1/2/3): "));
      if (ageAnswer === "2") {
        targetAgeGroup = "older_users_only";
      } else if (ageAnswer === "3") {
        targetAgeGroup = "mixed";
        isAppealToChildren = true;
      } else {
        targetAgeGroup = "all_ages";
        const appealAnswer = await askQuestion(
          chalk.cyan("  Could the app appeal to children even if not targeted at them? (y/N): ")
        );
        isAppealToChildren = appealAnswer.toLowerCase().startsWith("y");
      }
    }

    // 4. Government App
    const govAnswer = await askQuestion(
      chalk.cyan("  Is this a government app? (y/N): ")
    );
    const isGovernmentApp = govAnswer.toLowerCase().startsWith("y");

    // 5. Financial Features
    let hasFinancialFeatures = isFinanceApp || hasFinanceSDKs;
    if (hasFinancialFeatures) {
      console.log(chalk.white("  Financial features: ") + chalk.yellow("Detected"));
      const finConfirm = await askQuestion(
        chalk.cyan("  Does your app offer financial features (payments, digital wallet, crypto, etc.)? (Y/n): ")
      );
      if (finConfirm.toLowerCase() === "n") hasFinancialFeatures = false;
    } else {
      const finAnswer = await askQuestion(
        chalk.cyan("  Does your app offer financial features (payments, digital wallet, crypto, etc.)? (y/N): ")
      );
      hasFinancialFeatures = finAnswer.toLowerCase().startsWith("y");
    }
    let financialDetails: string | undefined;
    if (hasFinancialFeatures) {
      const finDetailsAnswer = await askQuestion(
        chalk.cyan("  Describe financial features briefly (or Enter to skip): ")
      );
      if (finDetailsAnswer) financialDetails = finDetailsAnswer;
    }

    // 6. Health App
    let isHealthAppDecl = isHealthApp || hasHealthSDKs;
    if (isHealthAppDecl) {
      console.log(chalk.white("  Health app: ") + chalk.yellow("Detected"));
      const healthConfirm = await askQuestion(
        chalk.cyan("  Is this a health or fitness app? (Y/n): ")
      );
      if (healthConfirm.toLowerCase() === "n") isHealthAppDecl = false;
    } else {
      const healthAnswer = await askQuestion(
        chalk.cyan("  Is this a health or fitness app? (y/N): ")
      );
      isHealthAppDecl = healthAnswer.toLowerCase().startsWith("y");
    }
    let healthDetails: string | undefined;
    if (isHealthAppDecl) {
      const healthDetailsAnswer = await askQuestion(
        chalk.cyan("  Describe health features briefly (or Enter to skip): ")
      );
      if (healthDetailsAnswer) healthDetails = healthDetailsAnswer;
    }

    report.play_store_declarations = {
      app_access: appAccess,
      app_access_instructions: appAccessInstructions,
      contains_ads: containsAds,
      target_age_group: targetAgeGroup,
      is_appeal_to_children: isAppealToChildren,
      is_government_app: isGovernmentApp,
      has_financial_features: hasFinancialFeatures,
      financial_features_details: financialDetails,
      is_health_app: isHealthAppDecl,
      health_app_details: healthDetails,
    };

    console.log();
    console.log(chalk.green("  ✓ Play Store declarations collected"));
    console.log(chalk.gray("  ─────────────────────────────────────"));
  }

  console.log();

  // Step 11a: Upload binary assets directly to Supabase Storage (bypasses Vercel 4.5MB body limit)
  try {
    const uploadCount =
      (report.app_assets?.length ?? 0) + (branding.app_icon_path ? 1 : 0);
    if (uploadCount > 0) {
      const uploadSpinner = ora({
        text: `Uploading ${uploadCount} asset${uploadCount === 1 ? "" : "s"}...`,
        prefixText: "  ",
      }).start();
      try {
        const uploaded = await uploadAssetsToStorage(
          client,
          rootDir,
          report.app_assets ?? [],
          branding.app_icon_path
        );
        report.app_assets = uploaded;
        // Icon is now in app_assets as `app_icon`; clear legacy field so server uses storage path.
        report.app_icon_base64 = null;
        uploadSpinner.succeed(chalk.green(`Uploaded ${uploaded.length} asset${uploaded.length === 1 ? "" : "s"}`));
      } catch (uploadError) {
        uploadSpinner.fail(
          chalk.red(
            `Asset upload failed: ${uploadError instanceof Error ? uploadError.message : "Unknown error"}`
          )
        );
        process.exit(1);
      }
    }
  } catch (e) {
    // Defensive: never let asset orchestration crash before submit.
    console.error(chalk.red(`Asset upload error: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }

  // Step 11b: Send report (now KB-sized, just metadata + storage paths)
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
