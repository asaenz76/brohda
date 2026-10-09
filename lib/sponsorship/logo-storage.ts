import "server-only";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSponsorshipConfig } from "./settings";
import { detectImageMime, SPONSOR_LOGO_BUCKET, SPONSOR_LOGO_OUTPUT_MAX_PX } from "./logo";

export type LogoResult = { ok: true; path: string } | { ok: false; status: number; error: string };

/**
 * Validates an uploaded logo WITHOUT storing it: the configured size limit and a magic-byte check of the actual bytes (the client-reported type is never
 * trusted; SVG is not accepted). Returns the verified bytes, ready to store.
 */
export async function validateLogo(file: File): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number; error: string }> {
  const maxBytes = await getSponsorshipConfig().then((c) => c.logoMaxBytes, () => null);
  if (maxBytes === null) return { ok: false, status: 503, error: "Uploads are unavailable right now. Try again shortly." };
  if (file.size > maxBytes) return { ok: false, status: 400, error: `The logo is too large (max ${Math.round(maxBytes / 1024)} KB).` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!detectImageMime(bytes)) return { ok: false, status: 400, error: "Unsupported image type. Use JPEG, PNG or WebP." };
  return { ok: true, bytes };
}

/** Re-encodes (which strips metadata and any embedded payload), stores under an unguessable name, points the sponsor at it and removes the old file. */
export async function storeSponsorLogo(sponsor: { id: string; logo_path: string | null }, bytes: Uint8Array): Promise<LogoResult> {
  const admin = createAdminClient();
  let encoded: Buffer;
  try {
    encoded = await sharp(bytes).rotate().resize(SPONSOR_LOGO_OUTPUT_MAX_PX, SPONSOR_LOGO_OUTPUT_MAX_PX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  } catch {
    return { ok: false, status: 400, error: "Could not process this image." };
  }
  const path = `${sponsor.id}/${randomUUID()}.webp`;
  const { error: uploadError } = await admin.storage.from(SPONSOR_LOGO_BUCKET).upload(path, encoded, { contentType: "image/webp", upsert: false });
  if (uploadError) return { ok: false, status: 500, error: "Could not upload image." };
  const { error: updateError } = await admin.from("sponsors").update({ logo_path: path }).eq("id", sponsor.id);
  if (updateError) {
    await admin.storage.from(SPONSOR_LOGO_BUCKET).remove([path]);
    return { ok: false, status: 500, error: "Could not save the logo." };
  }
  if (sponsor.logo_path) await admin.storage.from(SPONSOR_LOGO_BUCKET).remove([sponsor.logo_path]);
  return { ok: true, path };
}
