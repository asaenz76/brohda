import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { isUsableSession } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveActiveSponsorshipTarget } from "@/lib/sponsorship/public";

// First-party outbound click: /sponsorship/click/<id> -> the sponsorship's APPROVED destination. The destination is read from the stored, validated
// record — never from the request — so this cannot be used as an open redirect. The click is recorded only while the sponsorship is publicly active
// (same single eligibility policy as rendering); otherwise it is a plain 404. No third-party pixels, no cross-site identifiers.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new NextResponse("Not found", { status: 404 });

  const target = await resolveActiveSponsorshipTarget(id);
  if (!target) return new NextResponse("Not found", { status: 404 });

  const profile = await getCurrentUser().catch(() => null);
  const userId = isUsableSession(profile) ? profile.id : null;
  const admin = createAdminClient();
  await admin.from("sponsorship_exposure_events").insert({ sponsorship_id: id, post_id: target.postId, event_type: "CLICK", user_id: userId });

  const response = NextResponse.redirect(target.destinationUrl, 302);
  response.headers.set("Referrer-Policy", "strict-origin");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
