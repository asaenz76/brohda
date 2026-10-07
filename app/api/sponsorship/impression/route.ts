import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { isUsableSession } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveActiveSponsorshipTarget } from "@/lib/sponsorship/public";

// Impression definition (V1): a signed-in member's browser reported the sponsored label of an ACTIVE sponsorship as at least half visible for at least a
// second. One row per (sponsorship, member, UTC day) — the unique index makes re-renders, re-scrolls and double posts idempotent. Anonymous visitors are
// never recorded. An API fetch or a server render is NOT an impression.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = z.object({ sponsorshipId: z.uuid() }).safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 400 });

  const profile = await getCurrentUser().catch(() => null);
  if (!isUsableSession(profile)) return new NextResponse(null, { status: 204 });

  const target = await resolveActiveSponsorshipTarget(parsed.data.sponsorshipId);
  if (!target) return new NextResponse(null, { status: 204 });

  const admin = createAdminClient();
  const { error } = await admin.from("sponsorship_exposure_events").insert({ sponsorship_id: parsed.data.sponsorshipId, post_id: target.postId, event_type: "IMPRESSION", user_id: profile.id });
  if (error && error.code !== "23505") return new NextResponse(null, { status: 500 }); // 23505 = already counted today
  return new NextResponse(null, { status: 204 });
}
