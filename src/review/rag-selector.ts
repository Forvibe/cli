import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  RejectionStory,
  AppFeatureSignal,
  ReviewCategory,
} from "../types/review.js";

const DATA_FILES = [
  "safety.json",
  "performance.json",
  "business.json",
  "design.json",
  "legal.json",
  "common-pitfalls.json",
];

let cachedStories: RejectionStory[] | null = null;

function getDataDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Try multiple possible locations:
  // 1. src/review/rag-data (dev, running from source)
  // 2. dist/review/rag-data (bundled, __dirname = dist/)
  // 3. rag-data (if running directly from review/ dir)
  const candidates = [
    path.join(__dirname, "rag-data"),
    path.join(__dirname, "review", "rag-data"),
    path.join(__dirname, "..", "review", "rag-data"),
    path.join(__dirname, "..", "src", "review", "rag-data"),
  ];
  for (const dir of candidates) {
    try {
      readFileSync(path.join(dir, "safety.json"));
      return dir;
    } catch {
      // Try next
    }
  }
  return candidates[0]; // Fallback
}

export function loadAllStories(): RejectionStory[] {
  if (cachedStories) return cachedStories;

  const dataDir = getDataDir();
  const stories: RejectionStory[] = [];

  for (const file of DATA_FILES) {
    try {
      const content = readFileSync(path.join(dataDir, file), "utf-8");
      const parsed = JSON.parse(content) as RejectionStory[];
      stories.push(...parsed);
    } catch {
      // Skip missing files
    }
  }

  cachedStories = stories;
  return stories;
}

export function searchStories(
  signals: AppFeatureSignal[],
  maxResults: number = 20
): RejectionStory[] {
  const allStories = loadAllStories();
  if (signals.length === 0) return allStories.slice(0, maxResults);

  const signalKeywords = new Set(
    signals.flatMap((s) => s.keywords.map((k) => k.toLowerCase()))
  );
  const signalFeatures = new Set(
    signals.map((s) => s.feature.toLowerCase())
  );
  const signalCategories = new Set(signals.map((s) => s.category));

  const scored = allStories.map((story) => {
    let score = 0;

    // +3 for behavioral signal matching a detected feature
    for (const signal of story.behavioralSignals) {
      const signalLower = signal.toLowerCase();
      for (const feature of signalFeatures) {
        if (
          signalLower.includes(feature) ||
          feature.includes(signalLower.split(" ")[0])
        ) {
          score += 3;
          break;
        }
      }
    }

    // +2 for keyword matches
    for (const keyword of story.keywords) {
      if (signalKeywords.has(keyword.toLowerCase())) {
        score += 2;
      }
    }

    // +1 for category match
    if (signalCategories.has(story.category)) {
      score += 1;
    }

    return { story, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.story);
}

export function formatStoriesForPrompt(stories: RejectionStory[]): string {
  if (stories.length === 0) return "No relevant rejection stories found.";

  return stories
    .map((s, i) => {
      return `### Case ${i + 1}: ${s.guidelineName} (Guideline ${s.guidelineNumber})
**What happened:** ${s.whatDeveloperDid}
**Apple said:** "${s.whatAppleSaid}"
**The fix:** ${s.fix}
**User-visible signs:** ${s.behavioralSignals.join("; ")}`;
    })
    .join("\n\n");
}
