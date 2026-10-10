import type { ProviderAvailability, ProviderEnvironment } from "../types";

// ONVO runtime configuration — the ONVO adapter owns its own credential naming and environment parsing. Server-side only, from environment variables. FAILS CLOSED: anything missing, inconsistent or not explicitly authorized makes ONVO
// "unavailable" — it never falls back to a default key or a default mode, and a LIVE key alone does not turn live payments on.
//
//   ONVO_SECRET_KEY       the secret API key (onvo_test_secret_key_… for TEST, onvo_live_secret_key_… for LIVE). Never sent to a browser.
//   ONVO_WEBHOOK_SECRET   the webhook secret ONVO shows next to the webhook (webhook_secret_…). Without it payments could never be confirmed, so ONVO is unavailable.
//   ONVO_ENVIRONMENT      TEST or LIVE — an explicit declaration that must agree with the key's own prefix.
//   ONVO_LIVE_ENABLED     must be exactly "true" for LIVE to be available at all. Separate from the key on purpose: a live key can sit in the environment without
//                         live payments being on. (Live cutover is a separate, owner-authorized operation — see docs.)
//   ONVO_API_BASE         optional override of the API origin (defaults to the documented production API host).
// (Whether a TEST checkout is shown to Sponsors on the production deployment is a provider-neutral rule: lib/payments/config.ts.)
export const ONVO_DEFAULT_API_BASE = "https://api.onvopay.com";
const TEST_PREFIX = "onvo_test_";
const LIVE_PREFIX = "onvo_live_";

export interface OnvoConfig {
  secretKey: string;
  webhookSecret: string;
  environment: ProviderEnvironment;
  apiBase: string;
}

export type OnvoResolution = { ok: true; config: OnvoConfig } | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

export function resolveOnvoConfig(env: Env = process.env): OnvoResolution {
  const secretKey = env.ONVO_SECRET_KEY?.trim();
  const webhookSecret = env.ONVO_WEBHOOK_SECRET?.trim();
  if (!secretKey) return { ok: false, reason: "No ONVO secret key is configured." };
  const keyEnvironment: ProviderEnvironment | null = secretKey.startsWith(TEST_PREFIX) ? "TEST" : secretKey.startsWith(LIVE_PREFIX) ? "LIVE" : null;
  if (!keyEnvironment) return { ok: false, reason: "The ONVO secret key is not a recognised test or live key." };
  const declared = env.ONVO_ENVIRONMENT?.trim().toUpperCase();
  if (declared !== "TEST" && declared !== "LIVE") return { ok: false, reason: "ONVO_ENVIRONMENT must be set to TEST or LIVE." };
  if (declared !== keyEnvironment) return { ok: false, reason: "ONVO_ENVIRONMENT does not match the key (a test key with LIVE, or a live key with TEST)." };
  if (!webhookSecret) return { ok: false, reason: "No ONVO webhook secret is configured, so payments could not be confirmed." };
  if (keyEnvironment === "LIVE" && env.ONVO_LIVE_ENABLED !== "true") return { ok: false, reason: "Live ONVO payments are not enabled." };
  const apiBase = (env.ONVO_API_BASE?.trim() || ONVO_DEFAULT_API_BASE).replace(/\/+$/, "");
  // https always — except a local sandbox (http://127.0.0.1 / localhost) for a TEST key, which is how automated tests stand in for the provider.
  const localSandbox = keyEnvironment === "TEST" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(apiBase);
  if (!/^https:\/\//.test(apiBase) && !localSandbox) return { ok: false, reason: "ONVO_API_BASE must be an https URL." };
  return { ok: true, config: { secretKey, webhookSecret, environment: keyEnvironment, apiBase } };
}

export function onvoAvailability(env: Env = process.env): ProviderAvailability {
  const resolved = resolveOnvoConfig(env);
  if (!resolved.ok) return { state: "unavailable", reason: resolved.reason };
  return resolved.config.environment === "LIVE" ? { state: "live", environment: "LIVE" } : { state: "test", environment: "TEST" };
}
