import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { RulepackBundle } from "../../src/engine/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads the committed rulepack snapshot directly (no network, no
 * loadRulepackBundle) for engine integration tests. This is the exact bundle
 * the CLI ships, so its version/content contract is under test too.
 */
export function loadSnapshotBundle(): RulepackBundle {
  const snapshotPath = path.join(
    __dirname,
    "..",
    "..",
    "src",
    "engine",
    "data",
    "bundle.appstore.json"
  );
  return JSON.parse(readFileSync(snapshotPath, "utf-8")) as RulepackBundle;
}
