import { NextResponse } from "next/server";
import { handleProviderWebhook } from "@/lib/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ONVO webhook endpoint (sponsorship payments only). Authentication, verification and idempotency live in lib/payments; this route only reads the raw body and
// returns the status ONVO needs: 2xx = received and processed (including "duplicate" and "ignored"), 401 = bad secret, 5xx = please retry. The rejection bodies say
// nothing about WHY. A GET (or any other method) is just "not found".
export async function POST(request: Request) {
  const rawBody = await request.text();
  const result = await handleProviderWebhook(request.headers, rawBody);
  return NextResponse.json(result.body, { status: result.status });
}

export function GET() {
  return new NextResponse(null, { status: 404 });
}
