import "server-only";
import { checkRateLimit } from "./check";

const REGISTER_WINDOW_SECONDS = 15 * 60;
const REGISTER_MAX_ATTEMPTS = 5;

/** Same shape as checkLoginRateLimit — keyed by email, a tighter budget
 * than login since each attempt can create a real account. */
export async function checkRegisterRateLimit(identifier: string): Promise<boolean> {
  return checkRateLimit(`register:${identifier}`, REGISTER_WINDOW_SECONDS, REGISTER_MAX_ATTEMPTS);
}
