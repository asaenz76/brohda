// Sponsor logo rules. Limits (max bytes) come from platform settings; the allowed types and output size are format facts, not policy.
// SVG is deliberately NOT accepted (it can carry script); only raster formats whose magic bytes are verified server-side.
export const SPONSOR_LOGO_BUCKET = "sponsor-logos";
export const SPONSOR_LOGO_OUTPUT_MAX_PX = 512;
export { detectImageMime } from "@/lib/validations/avatar";

export function sponsorLogoPublicUrl(path: string | null | undefined, supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  if (!path || !supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${SPONSOR_LOGO_BUCKET}/${path}`;
}
