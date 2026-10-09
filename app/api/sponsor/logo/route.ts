import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { isSuperAdmin, isUsableSession } from "@/lib/auth/guards";
import { getSponsorSession } from "@/lib/sponsor/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { storeSponsorLogo, validateLogo } from "@/lib/sponsorship/logo-storage";
import { writeAuditLog } from "@/lib/audit/log";

// Sponsor logo upload. Server-side only (service role), after: a real session that is either Super Admin or the SPONSOR account that owns this organization,
// the organization's status (a Sponsor can change its logo only while its application is under review — once ACTIVE the brand identity is locked and a
// change goes through Super Admin), the configured size limit, and a magic-byte check of the actual file. The image is re-encoded and stored under an
// unguessable name.
export async function POST(request: Request) {
  const [profile, sponsorSession] = await Promise.all([getCurrentUser().catch(() => null), getSponsorSession().catch(() => null)]);
  const superAdmin = isUsableSession(profile) && isSuperAdmin(profile);
  if (!superAdmin && !sponsorSession) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const form = await request.formData();
  const sponsorId = z.uuid().safeParse(form.get("sponsorId"));
  const file = form.get("file");
  if (!sponsorId.success || !(file instanceof File)) return NextResponse.json({ error: "No file provided." }, { status: 400 });
  // A Sponsor can only ever act on ITS OWN organization; anything else looks exactly like a missing one.
  if (!superAdmin && sponsorSession?.sponsor.id !== sponsorId.data) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const admin = createAdminClient();
  const { data: sponsor } = await admin.from("sponsors").select("id, status, logo_path").eq("id", sponsorId.data).maybeSingle();
  if (!sponsor) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!superAdmin && sponsor.status !== "PENDING_REVIEW") return NextResponse.json({ error: "Your brand details are locked. Contact Brohda to change your logo." }, { status: 403 });

  const checked = await validateLogo(file);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: checked.status });
  const stored = await storeSponsorLogo(sponsor, checked.bytes);
  if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: stored.status });

  await writeAuditLog({ actorId: superAdmin ? profile!.id : null, actorAccountId: superAdmin ? null : sponsorSession!.userId, action: "sponsor.logo_updated", entityType: "sponsor", entityId: sponsor.id, before: { logoPath: sponsor.logo_path }, after: { logoPath: stored.path } });
  return NextResponse.json({ logoPath: stored.path });
}
