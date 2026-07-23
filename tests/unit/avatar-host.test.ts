import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedAvatarHost } from "@/lib/utils/avatar";

describe("isAllowedAvatarHost", () => {
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefgh.supabase.co";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
  });

  it("allows the configured Supabase storage host over https", () => {
    expect(isAllowedAvatarHost("https://abcdefgh.supabase.co/storage/v1/object/public/avatars/x.webp")).toBe(
      true,
    );
  });

  it("allows 127.0.0.1 over http (local Supabase)", () => {
    expect(isAllowedAvatarHost("http://127.0.0.1:54321/storage/v1/object/public/avatars/x.webp")).toBe(true);
  });

  it("rejects an unconfigured external host — the exact crash this guards against", () => {
    expect(isAllowedAvatarHost("https://example.test/avatars/some-file.webp")).toBe(false);
  });

  it("rejects the Supabase hostname over plain http", () => {
    expect(isAllowedAvatarHost("http://abcdefgh.supabase.co/storage/v1/object/public/avatars/x.webp")).toBe(
      false,
    );
  });

  it("rejects a malformed URL instead of throwing", () => {
    expect(isAllowedAvatarHost("not a url")).toBe(false);
  });

  it("rejects everything when NEXT_PUBLIC_SUPABASE_URL isn't set", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(isAllowedAvatarHost("https://abcdefgh.supabase.co/storage/v1/object/public/avatars/x.webp")).toBe(
      false,
    );
  });
});
