/**
 * Pixel size of a PNG, JPEG, or WebP file, read from its header without
 * decoding the image. Null when the format is unknown or the header is cut.
 */
export function imageSize(buffer: Buffer): { width: number; height: number } | null {
  try {
    // PNG: signature, then the IHDR chunk holds width and height.
    if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
      return valid(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    }
    // JPEG: walk the segments to the first frame header (SOF).
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) return valid(buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5));
        offset += 2 + length;
      }
      return null;
    }
    // WebP: RIFF container with a VP8, VP8L, or VP8X chunk.
    if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      const chunk = buffer.toString("ascii", 12, 16);
      if (chunk === "VP8X") return valid(1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3));
      if (chunk === "VP8 ") return valid(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
      if (chunk === "VP8L") {
        const bits = buffer.readUInt32LE(21);
        return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function valid(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : null;
}
