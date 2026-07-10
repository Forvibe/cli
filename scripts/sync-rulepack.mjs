#!/usr/bin/env node
// Syncs review-engine content into the single committed RulepackBundle
// snapshot at src/engine/data/bundle.appstore.json. Two source modes:
//   --from-dir <path>   read forvibeapp's content directory directly
//   --from-url <url>    fetch the live /api/v1/review-rulepack endpoint
// Defaults to --from-dir against the sibling forvibeapp checkout so
// `npm run sync:rulepack` works out of the box in this repo's usual layout.
//
// Plain Node ESM, no dependencies beyond node builtins (per brief).

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolved relative to this script's own location (not process.cwd()) so the
// script behaves the same regardless of where `npm run sync:rulepack` is
// invoked from, and so tests can sandbox it by copying just this one file
// into a throwaway directory tree.
const REPO_ROOT = path.join(__dirname, "..");
const OUTPUT_PATH = path.join(REPO_ROOT, "src", "engine", "data", "bundle.appstore.json");
const DEFAULT_CONTENT_DIR = path.join(REPO_ROOT, "..", "forvibeapp", "src", "lib", "review-engine", "content");
const STORE = "appstore";

// Fixed category order, mirroring forvibeapp's src/lib/review-engine/bundle.ts
// static import order (safety, performance, business, design, legal,
// common-pitfalls), so a --from-dir sync assembles the stories array in the
// same sequence as the live bundle instead of readdir's alphabetical order.
const STORY_CATEGORY_ORDER = [
  "safety.json",
  "performance.json",
  "business.json",
  "design.json",
  "legal.json",
  "common-pitfalls.json",
];

class SyncError extends Error {}

function parseArgs(argv) {
  let fromDir;
  let fromUrl;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from-dir") {
      fromDir = argv[++i];
      if (fromDir === undefined) throw new SyncError("--from-dir requires a path argument");
    } else if (arg.startsWith("--from-dir=")) {
      fromDir = arg.slice("--from-dir=".length);
    } else if (arg === "--from-url") {
      fromUrl = argv[++i];
      if (fromUrl === undefined) throw new SyncError("--from-url requires a URL argument");
    } else if (arg.startsWith("--from-url=")) {
      fromUrl = arg.slice("--from-url=".length);
    }
  }
  if (fromDir && fromUrl) {
    throw new SyncError("Pass either --from-dir or --from-url, not both.");
  }
  return { fromDir, fromUrl };
}

async function readJson(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new SyncError(`Cannot read ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SyncError(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

async function buildFromDir(contentDir) {
  if (!existsSync(contentDir)) {
    throw new SyncError(`Content directory not found: ${contentDir}`);
  }

  const rulepack = await readJson(path.join(contentDir, "rulepack.appstore.json"));
  const sdkRegistry = await readJson(path.join(contentDir, "sdk-registry.json"));
  const guidelines = await readJson(path.join(contentDir, "guidelines.json"));

  if (!Array.isArray(rulepack.rules)) {
    throw new SyncError(`rulepack.appstore.json is missing a 'rules' array`);
  }
  if (!Array.isArray(sdkRegistry.sdks)) {
    throw new SyncError(`sdk-registry.json is missing a 'sdks' array`);
  }

  const storiesDir = path.join(contentDir, "stories");
  let discoveredFiles;
  try {
    discoveredFiles = (await readdir(storiesDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    throw new SyncError(`Cannot read stories directory ${storiesDir}: ${err.message}`);
  }
  if (discoveredFiles.length === 0) {
    throw new SyncError(`No *.json story files found in ${storiesDir}`);
  }

  // Merge story files in STORY_CATEGORY_ORDER (matching forvibeapp's
  // bundle.ts), not readdir's alphabetical order, so the assembled stories
  // array is sequence-identical to the live bundle. Any unrecognized extra
  // *.json file is appended alphabetically after the known categories
  // rather than silently dropped.
  const knownFiles = STORY_CATEGORY_ORDER.filter((f) => discoveredFiles.includes(f));
  const extraFiles = discoveredFiles.filter((f) => !STORY_CATEGORY_ORDER.includes(f)).sort();
  const storyFiles = [...knownFiles, ...extraFiles];

  const stories = [];
  for (const file of storyFiles) {
    const filePath = path.join(storiesDir, file);
    const parsed = await readJson(filePath);
    if (!Array.isArray(parsed)) {
      throw new SyncError(`Expected an array of stories in ${filePath}, got ${typeof parsed}`);
    }
    stories.push(...parsed);
  }

  return {
    schema_version: 1,
    store: STORE,
    version: rulepack.version,
    updated_at: rulepack.updated_at,
    rules: rulepack.rules,
    sdk_registry: sdkRegistry.sdks,
    stories,
    guidelines,
  };
}

async function buildFromUrl(baseUrl) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/review-rulepack?store=${STORE}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new SyncError(`Fetch failed for ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new SyncError(`Fetch failed for ${url}: HTTP ${res.status}`);
  }
  let bundle;
  try {
    bundle = await res.json();
  } catch (err) {
    throw new SyncError(`Invalid JSON response from ${url}: ${err.message}`);
  }
  if (bundle?.schema_version !== 1) {
    throw new SyncError(
      `Unexpected schema_version ${JSON.stringify(bundle?.schema_version)} from ${url} (expected 1)`
    );
  }
  return bundle;
}

function countBundle(bundle) {
  return {
    rules: bundle.rules?.length ?? 0,
    sdks: bundle.sdk_registry?.length ?? 0,
    stories: bundle.stories?.length ?? 0,
    guidelines: Object.keys(bundle.guidelines ?? {}).length,
  };
}

async function readPreviousVersion() {
  try {
    const existing = JSON.parse(await readFile(OUTPUT_PATH, "utf-8"));
    if (existing && typeof existing.version === "string") {
      return existing.version;
    }
  } catch {
    // No existing snapshot yet (or it's unreadable) - reported as "none".
  }
  return "none";
}

async function main() {
  const { fromDir, fromUrl } = parseArgs(process.argv.slice(2));

  let bundle;
  if (fromUrl) {
    console.log(`Fetching rulepack from ${fromUrl} ...`);
    bundle = await buildFromUrl(fromUrl);
  } else {
    const contentDir = fromDir ? path.resolve(process.cwd(), fromDir) : DEFAULT_CONTENT_DIR;
    console.log(`Reading rulepack content from ${contentDir} ...`);
    bundle = await buildFromDir(contentDir);
  }

  if (bundle.schema_version !== 1) {
    throw new SyncError(`Assembled bundle has schema_version ${bundle.schema_version}, expected 1`);
  }

  const previousVersion = await readPreviousVersion();

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(bundle, null, 2) + "\n", "utf-8");

  const counts = countBundle(bundle);
  console.log(`${bundle.store}: ${previousVersion} -> ${bundle.version}`);
  console.log(
    `rules=${counts.rules} sdks=${counts.sdks} stories=${counts.stories} guidelines=${counts.guidelines}`
  );
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

main().catch((err) => {
  if (err instanceof SyncError) {
    console.error(`sync-rulepack: ${err.message}`);
  } else {
    console.error(`sync-rulepack: unexpected error: ${err?.stack ?? err}`);
  }
  process.exitCode = 1;
});
