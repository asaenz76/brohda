export const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5MB
export const AVATAR_OUTPUT_SIZE = 256; // px, square

// Magic-byte signatures for the MIME types we accept. Checked against the
// actual file bytes server-side — never trust the client-reported MIME type.
export const AVATAR_SIGNATURES: Array<{ mime: string; signature: number[] }> = [
  { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
  { mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/webp", signature: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"; WEBP checked at offset 8 too
];

export function detectImageMime(bytes: Uint8Array): string | null {
  for (const { mime, signature } of AVATAR_SIGNATURES) {
    if (signature.every((byte, i) => bytes[i] === byte)) {
      if (mime === "image/webp") {
        const webpMarker = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8
        if (!webpMarker.every((byte, i) => bytes[8 + i] === byte)) continue;
      }
      return mime;
    }
  }
  return null;
}
