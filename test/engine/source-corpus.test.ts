import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceCorpus, CORPUS_MAX_FILE_BYTES } from "../../src/engine/source-corpus.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forvibe-corpus-"));
  mkdirSync(join(root, "lib", "features", "settings", "view"), { recursive: true });
  mkdirSync(join(root, "lib", "gen"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  writeFileSync(join(root, "lib", "main.dart"), "void main() { runApp(); } // entry point");
  writeFileSync(
    join(root, "lib", "features", "settings", "view", "settings_view.dart"),
    "Future<void> deleteAccount() async { launchUrl('https://x/privacy-policy'); }"
  );
  // Deep + large: the shape that used to be dropped by the per-file cap.
  writeFileSync(
    join(root, "lib", "features", "settings", "view", "big_service.dart"),
    "// pad\n".repeat(30000) + "\nFuture<bool> deleteAccount() async => true;\n"
  );
  // Filtered: generated + test. Present, but not a coverage gap.
  writeFileSync(join(root, "lib", "gen", "assets.g.dart"), "class Assets { static const a = 1; }");
  writeFileSync(join(root, "test", "widget_test.dart"), "void main() { testWidgets(); }");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readSourceCorpus", () => {
  it("reads every discovered file untruncated and reports complete coverage", () => {
    const corpus = readSourceCorpus(root, "flutter");

    expect(corpus.coverage.complete).toBe(true);
    expect(corpus.coverage.limits_hit).toEqual([]);
    // Every discovered path is accounted for as either read or filtered.
    expect(corpus.coverage.read + corpus.coverage.filtered).toBe(corpus.coverage.discovered);

    const big = corpus.files.find((f) => f.path.endsWith("big_service.dart"));
    expect(big).toBeDefined();
    // The whole point: content past the old 15k truncation is still present.
    expect(big!.content.length).toBeGreaterThan(15000);
    expect(big!.content).toContain("deleteAccount");
  });

  it("filters test and generated files without marking coverage incomplete", () => {
    const corpus = readSourceCorpus(root, "flutter");
    const paths = corpus.files.map((f) => f.path);

    expect(paths.some((p) => p.includes("widget_test"))).toBe(false);
    expect(paths.some((p) => p.endsWith(".g.dart"))).toBe(false);
    expect(corpus.coverage.filtered).toBeGreaterThan(0);
    expect(corpus.coverage.complete).toBe(true);
  });

  it("marks coverage incomplete when the file cap truncates the walk", () => {
    const corpus = readSourceCorpus(root, "flutter", { maxFiles: 2 });

    expect(corpus.coverage.complete).toBe(false);
    expect(corpus.coverage.limits_hit).toContain("max_files");
  });

  it("marks coverage incomplete when the byte budget runs out", () => {
    const corpus = readSourceCorpus(root, "flutter", { maxBytes: 100 });

    expect(corpus.coverage.complete).toBe(false);
    expect(corpus.coverage.limits_hit).toContain("max_bytes");
  });

  it("returns files sorted by path so truncation is deterministic", () => {
    const a = readSourceCorpus(root, "flutter").files.map((f) => f.path);
    const b = readSourceCorpus(root, "flutter").files.map((f) => f.path);

    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it("keeps the per-file ceiling well above the 1MB readFileSafe default", () => {
    // Compliance code lives in oversized god-service files; a 1MB cap silently
    // dropped exactly those and produced false "not found" signals.
    expect(CORPUS_MAX_FILE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
