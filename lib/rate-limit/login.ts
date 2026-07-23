import "server-only";
import { checkRateLimit } from "./check";

const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 10;

/**
 * Returns true if the attempt is allowed, false if the identifier
 * (typically an email) has exceeded the attempt budget for the current
 * window.
 */
export async function checkLoginRateLimit(identifier: string): Promise<boolean> {
  return checkRateLimit(`login:${identifier}`, LOGIN_WINDOW_SECONDS, LOGIN_MAX_ATTEMPTS);
}
