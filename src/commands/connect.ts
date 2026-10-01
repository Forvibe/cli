import { createInterface } from "readline";
import chalk from "chalk";
import ora from "ora";
import { getAvailableProviders, type AIProvider } from "../ai/providers.js";
import type { ConnectionFlow, ForvibeClient } from "../api/forvibe-client.js";

export function askQuestion(question: string): Promise<string> {
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

/** Picks the user's own AI provider; source code is only ever sent there. */
export async function chooseProvider(): Promise<AIProvider> {
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

  let provider: AIProvider;

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
  return provider;
}

/**
 * Asks for the connection code and redeems it. A command tied to one flow
 * passes `expectedFlow`, so the server refuses another flow's code without
 * consuming it.
 */
export async function connectWithCode(client: ForvibeClient, expectedFlow?: ConnectionFlow): Promise<void> {
  const otcCode = await askQuestion(
    chalk.cyan("  🔗 Enter your Forvibe connection code: ")
  );

  if (!otcCode || otcCode.length < 6) {
    console.log(
      chalk.red("\n  ✗ Invalid code. Please enter the 6-character code from forvibe.app\n")
    );
    process.exit(1);
  }

  const connectSpinner = ora({
    text: "Connecting to Forvibe...",
    prefixText: "  ",
  }).start();

  try {
    await client.validateOTC(otcCode, expectedFlow);
    connectSpinner.succeed(chalk.green("Connected to Forvibe!"));
  } catch (error) {
    connectSpinner.fail(
      chalk.red(error instanceof Error ? error.message : "Connection failed")
    );
    process.exit(1);
  }

  console.log();
}
