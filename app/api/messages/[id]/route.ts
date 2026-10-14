import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { isUsableSession } from "@/lib/auth/guards";
import { getAccountContext } from "@/lib/auth/account";
import { isMessagingEnabled } from "@/lib/messaging/config";
import { getConversationDelta } from "@/lib/messaging/queries";
import { withShares } from "@/lib/messaging/views";
import { isUuid } from "@/lib/messaging/share";

// What changed in ONE conversation since the caller last looked: new messages (by sequence cursor) plus anything unsent or removed since the last poll. It is a targeted, indexed read of the
// caller's own conversation through RLS — never a scan of history. A conversation that is not the caller's returns the same empty answer as "no news"; Messaging being off is a 404.
const NOT_FOUND = () => new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NOT_FOUND();
  const profile = await getCurrentUser().catch(() => null);
  if (!isUsableSession(profile)) return new NextResponse(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  if ((await getAccountContext())?.accountType !== "MEMBER") return NOT_FOUND();
  if (!(await isMessagingEnabled())) return NOT_FOUND();

  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") ?? "0");
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  if (!Number.isFinite(after) || after < 0 || Number.isNaN(Date.parse(since))) return NOT_FOUND();

  const delta = await getConversationDelta(profile.id, id, Math.floor(after), new Date(since).toISOString());
  const messages = await withShares(profile.id, delta.messages);
  return NextResponse.json({ messages, serverTime: delta.serverTime }, { headers: { "Cache-Control": "no-store" } });
}
