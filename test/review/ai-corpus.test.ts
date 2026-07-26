import { describe, it, expect } from "vitest";
import { selectAiCorpus, excerptAround } from "../../src/review/ai-corpus.js";
import type { SourceCorpus } from "../../src/engine/source-corpus.js";
import type { SignalHit } from "../../src/engine/profile-builder.js";

function corpusOf(files: { path: string; content: string }[]): SourceCorpus {
  return {
    files,
    coverage: {
      discovered: files.length,
      read: files.length,
      filtered: 0,
      total_bytes: files.reduce((n, f) => n + f.content.length, 0),
      complete: true,
      limits_hit: [],
    },
  };
}

describe("excerptAround", () => {
  it("returns short files whole", () => {
    expect(excerptAround("short file", [0], 15000)).toBe("short file");
  });

  it("keeps the match that head-truncation would have thrown away", () => {
    // The exact failure this exists to prevent: deleteAccount at line 1186 of
    // a 95KB api_service.dart. Selecting the file is pointless if the excerpt
    // is just its first 15k characters.
    const filler = "// padding line\n".repeat(6000); // ~96KB
    const content = `${filler}Future<bool> deleteAccount() async => true;\n${filler}`;
    const index = content.indexOf("deleteAccount");
    expect(index).toBeGreaterThan(15000);

    const excerpt = excerptAround(content, [index], 15000);

    expect(excerpt).toContain("deleteAccount");
    expect(excerpt.length).toBeLessThanOrEqual(15000 + 200); // + omission markers
  });

  it("merges overlapping windows and marks omitted regions", () => {
    const content = "A".repeat(50000) + "NEEDLE" + "B".repeat(50000);
    const idx = content.indexOf("NEEDLE");
    const excerpt = excerptAround(content, [idx, idx + 2], 15000);

    expect(excerpt).toContain("NEEDLE");
    expect(excerpt).toContain("chars omitted");
  });
});

describe("selectAiCorpus", () => {
  const files = [
    { path: "lib/main.dart", content: "void main() {}" },
    { path: "lib/core/services/api_service.dart", content: "Future deleteAccount() async {}" },
    { path: "lib/features/settings/view/settings_view.dart", content: "privacy policy link" },
    { path: "lib/features/home/widget/card.dart", content: "class Card {}" },
  ];
  const hits: SignalHit[] = [
    { path: "lib/core/services/api_service.dart", signal: "account_deletion", index: 7 },
    { path: "lib/core/services/api_service.dart", signal: "ugc_surface", index: 0 },
    { path: "lib/features/settings/view/settings_view.dart", signal: "privacy_policy_link", index: 0 },
  ];

  it("puts evidence files first, ranked by distinct signal count", () => {
    const sel = selectAiCorpus(corpusOf(files), hits, "flutter", 150000);

    expect(sel.files[0].path).toBe("lib/core/services/api_service.dart"); // 2 signals
    expect(sel.files[1].path).toBe("lib/features/settings/view/settings_view.dart"); // 1 signal
    expect(sel.evidenceFileCount).toBe(2);
  });

  it("includes every discovered path in the inventory regardless of budget", () => {
    // Tiny budget: the corpus is truncated, the inventory is not. This is what
    // lets the model distinguish "no such file" from "file not shown to me".
    const sel = selectAiCorpus(corpusOf(files), hits, "flutter", 10);

    expect(sel.inventory).toHaveLength(files.length);
    expect(sel.inventory).toContain("lib/features/home/widget/card.dart");
    expect(sel.selectedFrom).toBe(files.length);
  });

  it("caps evidence files so they cannot consume the whole prompt", () => {
    const big = Array.from({ length: 20 }, (_, i) => ({
      path: `lib/f${i}.dart`,
      content: "x".repeat(5000),
    }));
    const bigHits: SignalHit[] = big.map((f, i) => ({
      path: f.path,
      signal: "ugc_surface" as const,
      index: i,
    }));

    const budget = 20000;
    const sel = selectAiCorpus(corpusOf(big), bigHits, "flutter", budget);
    const evidenceChars = sel.files
      .slice(0, sel.evidenceFileCount)
      .reduce((n, f) => n + f.content.length, 0);

    // 40% share, plus at most one file of overshoot.
    expect(evidenceChars).toBeLessThanOrEqual(budget * 0.4 + 5000);
  });

  it("is deterministic across runs", () => {
    const a = selectAiCorpus(corpusOf(files), hits, "flutter", 150000).files.map((f) => f.path);
    const b = selectAiCorpus(corpusOf(files), hits, "flutter", 150000).files.map((f) => f.path);
    expect(a).toEqual(b);
  });

  it("still selects non-evidence files when there are no hits at all", () => {
    const sel = selectAiCorpus(corpusOf(files), [], "flutter", 150000);
    expect(sel.evidenceFileCount).toBe(0);
    expect(sel.files.length).toBe(files.length);
  });
});
