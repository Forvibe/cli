import { describe, expect, it } from "vitest";
import { deriveUIColors } from "../../src/analyzers/branding.js";

describe("deriveUIColors", () => {
  it("classifies a dark theme palette by brightness", () => {
    const palette = deriveUIColors(
      ["#101626", "#101626", "#1b2440", "#ffffff", "#b6c0d9", "#4255ff", "#ffc857"],
      "#4255ff",
      null
    );

    expect(palette).toEqual({
      accent: "#ffc857",
      background: "#101626",
      surface: "#1b2440",
      text_primary: "#ffffff",
      text_secondary: "#b6c0d9",
      theme: "dark",
    });
  });

  it("classifies a light theme palette and flips the text end of the scale", () => {
    const palette = deriveUIColors(
      ["#ffffff", "#ffffff", "#f2f2f7", "#1c1c1e", "#6e6e73", "#007aff"],
      "#007aff",
      null
    );

    expect(palette).toMatchObject({
      background: "#ffffff",
      surface: "#f2f2f7",
      text_primary: "#1c1c1e",
      text_secondary: "#6e6e73",
      theme: "light",
    });
  });

  it("skips primary and secondary when choosing the accent", () => {
    const palette = deriveUIColors(
      ["#4255ff", "#4255ff", "#21c4a8", "#ffc857"],
      "#4255FF",
      "#21C4A8"
    );

    expect(palette.accent).toBe("#ffc857");
  });

  it("reports no theme when the project exposes no neutral surfaces", () => {
    const palette = deriveUIColors(["#4255ff", "#21c4a8"], "#4255ff", "#21c4a8");

    expect(palette).toEqual({
      accent: null,
      background: null,
      surface: null,
      text_primary: null,
      text_secondary: null,
      theme: null,
    });
  });
});
