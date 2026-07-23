import { describe, expect, it } from "vitest";
import { detectImageMime } from "@/lib/validations/avatar";

describe("detectImageMime", () => {
  it("detects JPEG from its magic bytes", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMime(bytes)).toBe("image/jpeg");
  });

  it("detects PNG from its magic bytes", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(detectImageMime(bytes)).toBe("image/png");
  });

  it("detects WebP from RIFF + WEBP markers", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // size (irrelevant)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectImageMime(bytes)).toBe("image/webp");
  });

  it("rejects a RIFF file that isn't WebP (e.g. AVI/WAV)", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // AVI (space)
    ]);
    expect(detectImageMime(bytes)).toBeNull();
  });

  it("rejects a file with a spoofed .jpg extension but no valid signature", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(detectImageMime(bytes)).toBeNull();
  });

  it("rejects an SVG/text payload disguised as an image", () => {
    const bytes = new TextEncoder().encode("<svg onload=alert(1)>");
    expect(detectImageMime(bytes)).toBeNull();
  });
});
