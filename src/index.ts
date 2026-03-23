#!/usr/bin/env node

import { Command } from "commander";
import { analyzeCommand } from "./commands/analyze.js";
import { reviewCommand } from "./commands/review.js";

const program = new Command();

program
  .name("forvibe")
  .description("Forvibe CLI — AI-powered App Store automation")
  .version("0.1.0");

program
  .command("analyze", { isDefault: true })
  .description(
    "Analyze your project and send the report to Forvibe for automated App Store setup"
  )
  .option("-d, --dir <path>", "Project directory to analyze", process.cwd())
  .option(
    "--api-url <url>",
    "Forvibe API URL (for development)",
    undefined
  )
  .action(analyzeCommand);

program
  .command("review")
  .description(
    "Simulate Apple's App Store review process on your project"
  )
  .option("-d, --dir <path>", "Project directory to review", process.cwd())
  .option("--deep", "Enable deep 2-pass review (feature detection + reviewer simulation)")
  .option("--format <type>", "Output format: terminal, json, markdown", "terminal")
  .option("--send", "Send results to Forvibe for combined review with metadata analysis")
  .option(
    "--api-url <url>",
    "Forvibe API URL (for development)",
    undefined
  )
  .action(reviewCommand);

program.parse();
