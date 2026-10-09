import "server-only";
import { checkRateLimit } from "./check";

const WINDOW_SECONDS = 15 * 60;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;

/** Sponsor applications create a real login and send an email, so they are limited both per email address and per network address. */
export async function checkSponsorSignupRateLimit(email: string, ip: string | null): Promise<boolean> {
  const byEmail = await checkRateLimit(`sponsor-signup:${email}`, WINDOW_SECONDS, MAX_PER_EMAIL);
  if (!byEmail) return false;
  if (!ip) return true;
  return checkRateLimit(`sponsor-signup-ip:${ip}`, WINDOW_SECONDS, MAX_PER_IP);
}

/** Resending a verification email is limited per address. */
export async function checkSponsorResendRateLimit(email: string): Promise<boolean> {
  return checkRateLimit(`sponsor-resend:${email}`, WINDOW_SECONDS, MAX_PER_EMAIL);
}
