// Remote rulepack loader: the CLI's freshness mechanism for the RulepackBundle
// content (rules/sdk_registry/stories/guidelines) that drives review checks.
//
// Fallback ladder (never blocks a review on the network):
//   1. disableRemote -> skip straight to cache/bundled.
//   2. fetch with If-None-Match (known etag) under an abort timeout.
//        200 + schema_version 1 -> "remote" (cache write is best-effort).
//        200 + unknown schema_version -> treated as a failed fetch (forward-compat gate).
//        304 -> read cached bundle; if missing/invalid, drop the now-stale
//               meta and fall through to bundled.
//        anything else (bad status / network error / timeout / bad JSON) -> fall through.
//   3. cache fallback -> "cache" if a valid (schema_version 1) cached bundle exists.
//   4. bundled fallback -> "bundled", read from the package's own data dir.
//   5. if even the bundled snapshot is unreadable, throw (broken install).
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RulepackBundle } from "./types.js";

export interface LoadedRulepack {
  bundle: RulepackBundle;
  source: "remote" | "cache" | "bundled";
  version: string;
}

export interface LoadRulepackOptions {
  baseUrl?: string; // default "https://forvibe.app"; callers pass --rulepack-url or --api-url override
  timeoutMs?: number; // default 2500
  cacheDir?: string; // default join(os.homedir(), ".forvibe", "cache"); injectable for tests
  disableRemote?: boolean; // skip network entirely (used by --offline-ish flows/tests)
}

const DEFAULT_BASE_URL = "https://forvibe.app";
const DEFAULT_TIMEOUT_MS = 2500;
const ENDPOINT_PATH = "/api/v1/review-rulepack?store=appstore";

const BUNDLE_FILENAME = "bundle.appstore.json";
const CACHE_BUNDLE_FILENAME = "rulepack-appstore.json";
const CACHE_META_FILENAME = "rulepack-appstore.meta.json";

interface CacheMeta {
  etag?: string;
  fetched_at?: string;
}

export async function loadRulepackBundle(opts: LoadRulepackOptions = {}): Promise<LoadedRulepack> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".forvibe", "cache");

  if (!opts.disableRemote) {
    const meta = await readCacheMeta(cacheDir);
    const headers: Record<string, string> = {};
    if (meta?.etag) headers["If-None-Match"] = meta.etag;

    const url = `${baseUrl.replace(/\/+$/, "")}${ENDPOINT_PATH}`;
    const outcome = await tryFetch(url, headers, timeoutMs);

    if (outcome.kind === "fresh") {
      // Cache write is a freshness optimization only - never let a write
      // failure (read-only home dir, full disk, etc.) fail an otherwise
      // successful remote load.
      await writeCache(cacheDir, outcome.bundle, outcome.etag);
      return { bundle: outcome.bundle, source: "remote", version: outcome.bundle.version };
    }

    if (outcome.kind === "not-modified") {
      const cached = await readCachedBundle(cacheDir);
      if (cached) {
        return { bundle: cached, source: "cache", version: cached.version };
      }
      // Server says our etag is still current, but we no longer have (or can
      // no longer read) the bundle it refers to - that etag is worthless
      // now, so drop it rather than sending it again next time.
      await deleteStaleMeta(cacheDir);
      return loadFromCacheOrBundled(cacheDir);
    }

    // outcome.kind === "failed": bad status, network error, timeout, bad
    // JSON, or an unsupported schema_version - all fall through identically.
  }

  return loadFromCacheOrBundled(cacheDir);
}

async function loadFromCacheOrBundled(cacheDir: string): Promise<LoadedRulepack> {
  const cached = await readCachedBundle(cacheDir);
  if (cached) {
    return { bundle: cached, source: "cache", version: cached.version };
  }
  const bundled = loadBundledSnapshot();
  return { bundle: bundled, source: "bundled", version: bundled.version };
}

// =============================================
// Network
// =============================================

type FetchOutcome =
  | { kind: "fresh"; bundle: RulepackBundle; etag: string | undefined }
  | { kind: "not-modified" }
  | { kind: "failed" };

async function tryFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, headers, timeoutMs);
  } catch {
    // Network error, DNS failure, or our own timeout guard below - all
    // treated the same: fall through to cache/bundled.
    return { kind: "failed" };
  }

  if (res.status === 304) {
    return { kind: "not-modified" };
  }
  if (!res.ok) {
    return { kind: "failed" };
  }

  let bundle: RulepackBundle;
  try {
    bundle = (await res.json()) as RulepackBundle;
  } catch {
    return { kind: "failed" };
  }

  // Forward-compat gate: a schema_version we don't understand is treated as
  // a failed fetch so we fall back to a bundle shape we know how to read.
  if (bundle?.schema_version !== 1) {
    return { kind: "failed" };
  }

  return { kind: "fresh", bundle, etag: res.headers.get("etag") ?? undefined };
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fetchPromise = fetch(url, { headers, signal: controller.signal });
  // Attach a rejection handler immediately so that if this promise loses the
  // race below (e.g. a fetch implementation that ignores AbortSignal and
  // settles later anyway) it can never surface as an unhandled rejection.
  fetchPromise.catch(() => {});

  try {
    return await Promise.race([
      fetchPromise,
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(`rulepack fetch timed out after ${timeoutMs}ms`)),
          { once: true }
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// =============================================
// Cache (disk)
// =============================================

async function readCacheMeta(cacheDir: string): Promise<CacheMeta | null> {
  try {
    const raw = await readFile(path.join(cacheDir, CACHE_META_FILENAME), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CacheMeta) : null;
  } catch {
    return null;
  }
}

async function readCachedBundle(cacheDir: string): Promise<RulepackBundle | null> {
  try {
    const raw = await readFile(path.join(cacheDir, CACHE_BUNDLE_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as RulepackBundle;
    // Schema_version gate applies to cache reads too (see module doc) - a
    // stale cache written by an older/newer CLI must not be trusted blindly.
    return parsed && parsed.schema_version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

async function deleteStaleMeta(cacheDir: string): Promise<void> {
  try {
    await rm(path.join(cacheDir, CACHE_META_FILENAME), { force: true });
  } catch {
    // Best-effort cleanup; a leftover meta file is retried (and possibly
    // re-deleted) next call.
  }
}

async function writeCache(
  cacheDir: string,
  bundle: RulepackBundle,
  etag: string | undefined
): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, CACHE_BUNDLE_FILENAME), JSON.stringify(bundle, null, 2), "utf-8");
    const meta: CacheMeta = { fetched_at: new Date().toISOString() };
    if (etag) meta.etag = etag; // omitted entirely when the server sent no ETag header
    await writeFile(path.join(cacheDir, CACHE_META_FILENAME), JSON.stringify(meta, null, 2), "utf-8");
  } catch {
    // Best-effort: see module doc. The remote result is still returned by
    // the caller regardless of whether this write succeeded.
  }
}

// =============================================
// Bundled fallback
// =============================================

// Mirrors src/review/rag-selector.ts's getDataDir() probing pattern: resolve
// the data directory relative to this module's own location (import.meta.url)
// rather than process.cwd(), so it works both in dev (src/engine/data) and
// once tsup bundles this into dist/ (as dist/index.js or a split chunk file -
// either way import.meta.url resolves to a flat file directly under dist/,
// regardless of this module's original source path).
function getEngineDataDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const candidates = [
    path.join(__dirname, "data"), // dev, running from source (src/engine/data)
    path.join(__dirname, "engine", "data"), // bundled, __dirname = dist/ -> dist/engine/data
    path.join(__dirname, "..", "engine", "data"),
    path.join(__dirname, "..", "src", "engine", "data"),
  ];
  for (const dir of candidates) {
    try {
      readFileSync(path.join(dir, BUNDLE_FILENAME));
      return dir;
    } catch {
      // Try next candidate.
    }
  }
  return candidates[0]; // Fallback; loadBundledSnapshot() will surface the read error.
}

function loadBundledSnapshot(): RulepackBundle {
  const filePath = path.join(getEngineDataDir(), BUNDLE_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Bundled rulepack snapshot not found at ${filePath}. This indicates a broken install - ` +
        `bundle.appstore.json should always ship with the package. (${(err as Error).message})`
    );
  }
  try {
    return JSON.parse(raw) as RulepackBundle;
  } catch (err) {
    throw new Error(`Bundled rulepack snapshot at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
}
