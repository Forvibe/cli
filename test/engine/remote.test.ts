import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRulepackBundle } from "../../src/engine/remote.js";
import type { RulepackBundle } from "../../src/engine/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, "..", "..");
const BUNDLED_SNAPSHOT_PATH = path.join(REPO_ROOT, "src", "engine", "data", "bundle.appstore.json");

function makeBundle(overrides: Partial<RulepackBundle> = {}): RulepackBundle {
  return {
    schema_version: 1,
    store: "appstore",
    version: "9.9.9-test",
    updated_at: "2026-01-01",
    rules: [],
    sdk_registry: [],
    stories: [],
    guidelines: {},
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const headers = new Headers();
  if (init.etag) headers.set("etag", init.etag);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe("loadRulepackBundle", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "rulepack-cache-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("200 happy path: source remote, cache bundle + meta written with etag", async () => {
    const bundle = makeBundle({ version: "1.2.3" });
    const fetchMock = vi.fn(async () => jsonResponse(bundle, { etag: '"abc123"' }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    expect(result.source).toBe("remote");
    expect(result.version).toBe("1.2.3");
    expect(result.bundle.version).toBe("1.2.3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://example.test/api/v1/review-rulepack?store=appstore"
    );

    const cachedBundle = JSON.parse(
      await readFile(path.join(cacheDir, "rulepack-appstore.json"), "utf-8")
    );
    expect(cachedBundle.version).toBe("1.2.3");

    const meta = JSON.parse(await readFile(path.join(cacheDir, "rulepack-appstore.meta.json"), "utf-8"));
    expect(meta.etag).toBe('"abc123"');
    expect(typeof meta.fetched_at).toBe("string");
  });

  it("200 with no ETag response header omits etag from cache meta", async () => {
    const bundle = makeBundle({ version: "1.2.3" });
    const fetchMock = vi.fn(async () => jsonResponse(bundle));
    vi.stubGlobal("fetch", fetchMock);

    await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    const meta = JSON.parse(await readFile(path.join(cacheDir, "rulepack-appstore.meta.json"), "utf-8"));
    expect(meta.etag).toBeUndefined();
    expect(typeof meta.fetched_at).toBe("string");
  });

  it("second call with a matching etag + 304 response -> source cache, sends If-None-Match", async () => {
    const bundle = makeBundle({ version: "1.2.3" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(bundle, { etag: '"abc123"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });
    expect(first.source).toBe("remote");

    const second = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    expect(second.source).toBe("cache");
    expect(second.version).toBe("1.2.3");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCallInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((secondCallInit.headers as Record<string, string>)["If-None-Match"]).toBe('"abc123"');
  });

  it("304 with a missing/unreadable cached bundle falls through to bundled and drops the stale meta", async () => {
    // First call succeeds and writes cache+meta...
    const bundle = makeBundle({ version: "1.2.3" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(bundle, { etag: '"abc123"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);
    await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    // ...then the cached bundle file itself disappears (corrupted disk, manual cleanup, etc.)
    // while the meta (and its etag) survives, so the next request is conditional again.
    await rm(path.join(cacheDir, "rulepack-appstore.json"), { force: true });

    const result = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    expect(result.source).toBe("bundled");
    const metaStillThere = await readFile(path.join(cacheDir, "rulepack-appstore.meta.json"), "utf-8").then(
      () => true,
      () => false
    );
    expect(metaStillThere).toBe(false);
  });

  it("network error + warm cache -> source cache", async () => {
    const bundle = makeBundle({ version: "4.5.6" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(bundle))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });
    expect(first.source).toBe("remote");

    const second = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    expect(second.source).toBe("cache");
    expect(second.version).toBe("4.5.6");
  });

  it("network error + cold cache -> source bundled (real committed snapshot)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    expect(result.source).toBe("bundled");
    const bundledSnapshot = JSON.parse(readFileSync(BUNDLED_SNAPSHOT_PATH, "utf-8"));
    expect(result.version).toBe(bundledSnapshot.version);
    expect(result.bundle.schema_version).toBe(1);
  });

  it("200 with schema_version 99 + cold cache -> source bundled (forward-compat gate)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ...makeBundle(), schema_version: 99 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    expect(result.source).toBe("bundled");
  });

  it("200 with schema_version 99 + warm cache -> source cache (does not overwrite the good cache)", async () => {
    const good = makeBundle({ version: "1.0.0" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(good))
      .mockResolvedValueOnce(jsonResponse({ ...makeBundle({ version: "2.0.0" }), schema_version: 99 }));
    vi.stubGlobal("fetch", fetchMock);

    await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });
    const result = await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    expect(result.source).toBe("cache");
    expect(result.version).toBe("1.0.0");
  });

  it("falls through to bundled on timeout, without hanging or an unhandled rejection", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Never settles - simulates a hung request that ignores AbortSignal.
          // loadRulepackBundle must still return via its own timeout guard
          // rather than waiting forever.
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadRulepackBundle({
      cacheDir,
      baseUrl: "https://example.test",
      timeoutMs: 30,
    });

    expect(result.source).toBe("bundled");
  });

  it("disableRemote skips the network entirely", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadRulepackBundle({ cacheDir, disableRemote: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.source).toBe("bundled");
  });

  it("disableRemote + warm cache -> source cache (still no fetch call)", async () => {
    const bundle = makeBundle({ version: "7.8.9" });
    const fetchMock = vi.fn(async () => jsonResponse(bundle));
    vi.stubGlobal("fetch", fetchMock);
    await loadRulepackBundle({ cacheDir, baseUrl: "https://example.test" });

    vi.unstubAllGlobals();
    const fetchMock2 = vi.fn();
    vi.stubGlobal("fetch", fetchMock2);

    const result = await loadRulepackBundle({ cacheDir, disableRemote: true });

    expect(fetchMock2).not.toHaveBeenCalled();
    expect(result.source).toBe("cache");
    expect(result.version).toBe("7.8.9");
  });
});
