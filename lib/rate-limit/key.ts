import "server-only";
import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";

/**
 * A rate-limit bucket's key for an email address or a network address. The value is hashed, so the rate_limits table never holds an email or an IP in the clear (and the rows are pruned once their window is long over).
 * Keyed with RATE_LIMIT_HMAC_SECRET when it is set; without it the hash is unkeyed SHA-256 — still not readable, but guessable for a known value, so set the secret in every deployed environment.
 * The key is the only thing this data is for: it is never read for analytics.
 */
export function limiterKey(namespace: string, value: string): string {
  const secret = process.env.RATE_LIMIT_HMAC_SECRET;
  const input = `${namespace}\0${value}`;
  const digest = secret ? createHmac("sha256", secret).update(input).digest("hex") : createHash("sha256").update(input).digest("hex");
  return `${namespace}:${digest.slice(0, 32)}`;
}

/** Expands any valid IPv6 text form to its eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  const [head, tail, ...extra] = address.split("::");
  if (extra.length > 0) return null;
  const parse = (part: string | undefined) => (part ? part.split(":") : []);
  let left = parse(head);
  let right = parse(tail);
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
  const v4ToGroups = (parts: string[]) => {
    const last = parts[parts.length - 1];
    if (last && last.includes(".")) {
      const octets = last.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
      return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
    }
    return parts;
  };
  const l = v4ToGroups(left);
  const r = v4ToGroups(right);
  if (!l || !r) return null;
  left = l;
  right = r;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (all.length !== 8) return null;
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

/**
 * The network identity a registration limit should count: an IPv4 address as itself, an IPv6 address as its /64 (one household or one device can hold billions of addresses in its /64, so counting full addresses
 * would let rotation inside a prefix walk straight past the limit), and an IPv4-mapped IPv6 address as the IPv4 it carries. Anything else is not an address, so there is nothing to limit on.
 */
export function networkIdentity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/^\[|\]$/g, "");
  value = value.split("%")[0];
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind !== 6) return null;
  const groups = ipv6Groups(value.toLowerCase());
  if (!groups) return null;
  // ::ffff:a.b.c.d — an IPv4 client reaching a dual-stack edge.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `v6:${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}`;
}

/**
 * The real client address, from the one header this platform guarantees. On Vercel `x-forwarded-for` carries the client's public IP and Vercel overwrites whatever the client sent (external values are not
 * forwarded), so its first entry cannot be spoofed. Anywhere else — local development, a different host or an added proxy — no header is trustworthy, so this returns null and no IP limit applies;
 * an attacker can't pick a fresh "address" by sending a header.
 */
export function clientNetworkIdentity(requestHeaders: Pick<Headers, "get">): string | null {
  if (process.env.VERCEL !== "1") return null;
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  return networkIdentity(forwarded || requestHeaders.get("x-real-ip"));
}
