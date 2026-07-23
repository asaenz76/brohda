// Mirrors next.config.ts's images.remotePatterns — next/image throws
// synchronously (crashing the whole page tree, not just the avatar) for any
// hostname not on that allow-list, so any avatarUrl must be checked here
// before ever reaching <Image>, not just trusted as "whatever's in the DB."
export function isAllowedAvatarHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.hostname === "127.0.0.1") {
    return parsed.protocol === "http:";
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseHostname = supabaseUrl ? new URL(supabaseUrl).hostname : undefined;
  return parsed.protocol === "https:" && !!supabaseHostname && parsed.hostname === supabaseHostname;
}
