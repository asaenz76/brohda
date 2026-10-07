import { NextResponse } from "next/server";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { isSuperAdmin, isUsableSession } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { detectImageMime, SPONSOR_LOGO_BUCKET, SPONSOR_LOGO_OUTPUT_MAX_PX } from "@/lib/sponsorship/logo";
import { writeAuditLog } from "@/lib/audit/log";

// Sponsor logo upload. Server-side only (service role), after: a real session, ownership (a member of this sponsor, or Super Admin), an ACTIVE sponsor
// (members only), the capability being ON (members only), the configured size limit, and a magic-byte check of the actual file (the client-reported type is
// never trusted; SVG is not accepted). The image is re-encoded (which strips metadata and any embedded payload) and stored under an unguessable name.
export async function POST(request: Request) {
  const profile = await getCurrentUser().catch(() => null);
  if (!isUsableSession(profile)) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const form = await request.formData();
  const sponsorId = z.uuid().safeParse(form.get("sponsorId"));
  const file = form.get("file");
  if (!sponsorId.success || !(file instanceof File)) return NextResponse.json({ error: "No file provided." }, { status: 400 });

  const admin = createAdminClient();
  const superAdmin = isSuperAdmin(profile);
  if (!superAdmin) {
    if (!(await isSponsorshipEnabled())) return NextResponse.json({ error: "Sponsored Game Posts aren't open right now." }, { status: 403 });
    const { data: member } = await admin.from("sponsor_users").select("user_id").eq("sponsor_id", sponsorId.data).eq("user_id", profile.id).maybeSingle();
    if (!member) return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const { data: sponsor } = await admin.from("sponsors").select("id, status, logo_path").eq("id", sponsorId.data).maybeSingle();
  if (!sponsor) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!superAdmin && sponsor.status !== "ACTIVE") return NextResponse.json({ error: "This sponsor account isn't active." }, { status: 403 });

  const maxBytes = await getSponsorshipConfig().then((c) => c.logoMaxBytes, () => null);
  if (maxBytes === null) return NextResponse.json({ error: "Uploads are unavailable right now. Try again shortly." }, { status: 503 });
  if (file.size > maxBytes) return NextResponse.json({ error: `The logo is too large (max ${Math.round(maxBytes / 1024)} KB).` }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!detectImageMime(bytes)) return NextResponse.json({ error: "Unsupported image type. Use JPEG, PNG or WebP." }, { status: 400 });

  let encoded: Buffer;
  try {
    encoded = await sharp(bytes).rotate().resize(SPONSOR_LOGO_OUTPUT_MAX_PX, SPONSOR_LOGO_OUTPUT_MAX_PX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  } catch {
    return NextResponse.json({ error: "Could not process this image." }, { status: 400 });
  }

  const path = `${sponsor.id}/${randomUUID()}.webp`;
  const { error: uploadError } = await admin.storage.from(SPONSOR_LOGO_BUCKET).upload(path, encoded, { contentType: "image/webp", upsert: false });
  if (uploadError) return NextResponse.json({ error: "Could not upload image." }, { status: 500 });

  const { error: updateError } = await admin.from("sponsors").update({ logo_path: path }).eq("id", sponsor.id);
  if (updateError) return NextResponse.json({ error: "Could not save the logo." }, { status: 500 });
  if (sponsor.logo_path) await admin.storage.from(SPONSOR_LOGO_BUCKET).remove([sponsor.logo_path]);

  await writeAuditLog({ actorId: profile.id, action: "sponsor.logo_updated", entityType: "sponsor", entityId: sponsor.id, before: { logoPath: sponsor.logo_path }, after: { logoPath: path } });
  return NextResponse.json({ logoPath: path });
}
