#!/usr/bin/env node

import { Command } from "commander";
import { analyzeCommand } from "./commands/analyze.js";

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
  .option(
    "--local",
    "Use local Gemini API key instead of Forvibe backend (requires GEMINI_API_KEY env var)"
  )
  .action(analyzeCommand);

program.parse();
