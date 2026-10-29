import "server-only";
import { checkRateLimitVerdict, type RateLimitVerdict } from "./check";
import { limiterKey } from "./key";

const REGISTER_WINDOW_SECONDS = 15 * 60;
const REGISTER_MAX_ATTEMPTS = 5;
// Rotating email addresses walks straight past the per-email budget, so sign-up is also limited per network address. The hour-long window is deliberately roomy for a shared address (a stadium, a bar, a campus) while
// still turning a script into a trickle; the per-address budget counts attempts that passed validation, not accounts.
const REGISTER_IP_WINDOW_SECONDS = 60 * 60;
const REGISTER_IP_MAX_ATTEMPTS = 20;

/**
 * Sign-up creates a real account, so unlike the other limiters this one does NOT fail open: when the check cannot be made the answer is "unavailable" and the attempt is refused with a retry message (account creation needs the same
 * database, so this costs nothing the sign-up wasn't already depending on). Both budgets are spent on every attempt that reaches here; the buckets hold only a hash of the email and of the network address.
 */
export async function checkRegisterRateLimit(email: string, networkIdentity: string | null): Promise<RateLimitVerdict> {
  const byEmail = await checkRateLimitVerdict(limiterKey("register", email), REGISTER_WINDOW_SECONDS, REGISTER_MAX_ATTEMPTS);
  if (byEmail !== "allowed") {
    console.warn(`[register] ${byEmail === "limited" ? "rate limit reached" : "rate limiter unavailable"} (email budget)`);
    return byEmail;
  }
  // The network budget switches on only where RATE_LIMIT_HMAC_SECRET is set — the rollout switch: turn it on per environment, watch `[register] rate limit reached (network budget)`, and unsetting the secret turns it off again.
  if (!networkIdentity || !process.env.RATE_LIMIT_HMAC_SECRET) return "allowed";
  const byNetwork = await checkRateLimitVerdict(limiterKey("register-net", networkIdentity), REGISTER_IP_WINDOW_SECONDS, REGISTER_IP_MAX_ATTEMPTS);
  if (byNetwork !== "allowed") console.warn(`[register] ${byNetwork === "limited" ? "rate limit reached" : "rate limiter unavailable"} (network budget)`);
  return byNetwork;
}
