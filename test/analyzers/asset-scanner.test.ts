import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scanAppAssets } from "../../src/analyzers/asset-scanner.js";
import { imageSize } from "../../src/utils/image-size.js";

/** A PNG with a real IHDR header, padded so the scanner treats it as a full image. */
function png(width: number, height: number, bytes = 20_000): Buffer {
  const buffer = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** A JPEG whose first frame header (SOF0) carries the size. */
function jpeg(width: number, height: number, bytes = 20_000): Buffer {
  const buffer = Buffer.alloc(bytes);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(buffer, 0);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff]).copy(buffer, 2 + 2 + 16);
  return buffer;
}

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("imageSize", () => {
  it("reads the size of PNG and JPEG files from their headers", () => {
    expect(imageSize(png(1206, 2622))).toEqual({ width: 1206, height: 2622 });
    expect(imageSize(jpeg(1179, 2556))).toEqual({ width: 1179, height: 2556 });
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
  });
});

describe("scanAppAssets", () => {
  it("keeps only real app screens from general image folders", () => {
    root = mkdtempSync(join(tmpdir(), "fv-assets-"));
    const images = join(root, "assets/images");
    mkdirSync(images, { recursive: true });
    writeFileSync(join(images, "android-icon-background.png"), png(1024, 1024));
    writeFileSync(join(images, "icon.png"), png(1024, 1024));
    writeFileSync(join(images, "logo-glow.png"), png(1200, 400));
    writeFileSync(join(images, "onboarding-art.png"), png(1024, 1024));
    writeFileSync(join(images, "home.png"), png(1206, 2622));
    writeFileSync(join(images, "plan.jpg"), jpeg(1179, 2556));

    const screens = scanAppAssets(root, "expo").filter((asset) => asset.asset_type === "screenshot");
    expect(screens.map((asset) => asset.file_name).sort()).toEqual(["home.png", "plan.jpg"]);
    expect(screens.find((asset) => asset.file_name === "home.png")).toMatchObject({ width: 1206, height: 2622 });
  });
});
