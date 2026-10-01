import { describe, expect, it } from "vitest";
import { buildScreenshotBriefPrompt, generateScreenshotBrief, normalizeScreenshotBrief } from "../../src/ai/screenshot-brief-generator.js";
import type { AIProvider } from "../../src/ai/providers.js";
import type { ScreenshotBriefInput } from "../../src/ai/screenshot-brief-generator.js";

const input: ScreenshotBriefInput = {
  techStack: { stack: "swift", label: "iOS Native (Swift/Objective-C)", platforms: ["ios"] } as ScreenshotBriefInput["techStack"],
  config: { app_name: "StudyFlow", bundle_id: "com.example.studyflow", version: "1.0", min_ios_version: null, min_android_sdk: null, description: null },
  branding: { primary_color: "#4255FF", secondary_color: null, app_icon_base64: null, app_icon_path: null, brand_colors: ["#4255FF", "#FFC857"] },
  detectedFonts: ["Poppins"],
  readmeContent: "StudyFlow turns lecture notes into flashcards. OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  sourceCode: 'let apiKey = "AIzaSyA1234567890abcdefghijklmnopqrstuv"\nstruct FlashcardView: View {}',
  projectTree: "StudyFlow/\n  FlashcardView.swift",
  screenshotCount: 3,
};

describe("screenshot brief", () => {
  it("redacts secrets before anything reaches the AI provider", () => {
    const prompt = buildScreenshotBriefPrompt(input);
    expect(prompt).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(prompt).not.toContain("AIzaSyA1234567890abcdefghijklmnopqrstuv");
    expect(prompt).toContain("FlashcardView");
    expect(prompt).toContain("#4255FF");
  });

  it("keeps 3 to 7 features ordered by priority and drops invalid hints", () => {
    const brief = normalizeScreenshotBrief({
      description: "Flashcards from your notes.",
      category: "Education",
      features: [
        { name: "Track streaks", priority: 40 },
        { name: "Turn notes into flashcards", description: "Paste notes, get a deck", priority: 95 },
        { name: "Spaced repetition", priority: 80 },
        { name: "", priority: 99 },
        ...Array.from({ length: 8 }, (_, index) => ({ name: `Extra ${index}`, priority: 10 })),
      ],
      brand_personality: ["focused", "calm"],
      ui_colors: { accent: "#ffc857", background: "not-a-color" },
      style: { theme: "dark", radius_style: "huge", density: "balanced" },
      screenshot_style_idea: { concept: "Notes become a deck", recurringMotifs: ["index cards"] },
    }, input);
    expect(brief.features.map((feature) => feature.name).slice(0, 3)).toEqual(["Turn notes into flashcards", "Spaced repetition", "Track streaks"]);
    expect(brief.features.length).toBe(7);
    expect(brief.screenshot_design?.ui_colors).toEqual({ accent: "#FFC857" });
    expect(brief.screenshot_design?.style).toEqual({ theme: "dark", density: "balanced" });
    expect(brief.screenshot_style_idea).toEqual({ concept: "Notes become a deck", recurringMotifs: ["index cards"] });
    expect(brief.app_name).toBe("StudyFlow");
    expect(brief.platforms).toEqual(["ios"]);
    expect(brief.primary_color).toBe("#4255FF");
  });

  it("asks the provider once and parses fenced JSON", async () => {
    const calls: string[] = [];
    const provider: AIProvider = {
      name: "fake",
      async generateJSON(_system, user) {
        calls.push(user);
        return "```json\n" + JSON.stringify({
          description: "Flashcards from notes.",
          features: [{ name: "A", priority: 3 }, { name: "B", priority: 2 }, { name: "C", priority: 1 }],
        }) + "\n```";
      },
    };
    const brief = await generateScreenshotBrief(input, provider);
    expect(calls).toHaveLength(1);
    expect(brief.features.map((feature) => feature.name)).toEqual(["A", "B", "C"]);
  });

  it("fails clearly when the model finds fewer than three features", () => {
    expect(() => normalizeScreenshotBrief({ features: [{ name: "Only one" }] }, input)).toThrow(/at least 3/);
  });
});
