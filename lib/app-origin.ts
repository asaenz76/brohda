import "server-only";
import { headers } from "next/headers";

/**
 * The origin Brohda's own absolute URLs are built from (verification and payment-return links). APP_URL is canonical; when it isn't configured (local and CI runs)
 * the request's own origin is used. Callers only ever append FIXED paths to it — a visitor can never supply the URL.
 */
export async function appOrigin(): Promise<string> {
  const configured = process.env.APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
