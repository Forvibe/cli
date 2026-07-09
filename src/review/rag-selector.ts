// RAG story selector, v2: stories are injected from the loaded RulepackBundle
// (remote -> cache -> bundled ladder in src/engine/remote.ts) instead of being
// read from a package-local rag-data directory. The old disk loader
// (getDataDir/loadAllStories) and src/review/rag-data/ are gone; the bundle is
// now the single source of truth for the rejection-story corpus.

import type { RejectionStory } from "../engine/types.js";
import type { AppFeatureSignal } from "../types/review.js";

/**
 * A search signal is either a full feature signal from the AI feature
 * discovery pass, or a plain string (SDK id or capability name from the
 * static engine's AppProfile, e.g. "google-mobile-ads", "subscriptions").
 */
export type StorySignal = AppFeatureSignal | string;

/**
 * Ranks `stories` against `signals` and returns the top `maxResults`.
 * Scoring (identical to v1):
 *   +3 when a story behavioralSignal matches a detected feature (substring
 *      either way, first word for the reverse direction)
 *   +2 per story keyword present in the signal keyword set
 *   +1 when the story category matches a signal category
 * Plain string signals contribute to both the feature set and the keyword set
 * (they carry no category).
 */
export function searchStories(
  stories: RejectionStory[],
  signals: StorySignal[],
  maxResults: number = 20
): RejectionStory[] {
  if (signals.length === 0) return stories.slice(0, maxResults);

  const signalKeywords = new Set<string>();
  const signalFeatures = new Set<string>();
  const signalCategories = new Set<string>();

  for (const signal of signals) {
    if (typeof signal === "string") {
      const value = signal.toLowerCase();
      signalFeatures.add(value);
      signalKeywords.add(value);
    } else {
      signalFeatures.add(signal.feature.toLowerCase());
      for (const keyword of signal.keywords) signalKeywords.add(keyword.toLowerCase());
      signalCategories.add(signal.category);
    }
  }

  const scored = stories.map((story) => {
    let score = 0;

    // +3 for each behavioral signal matching a detected feature
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
