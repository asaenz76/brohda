/**
 * Re-exports the same production guard/config resolver integration tests
 * use (tests/integration/helpers/test-env.ts) — E2E and integration tests
 * target the exact same isolated local Supabase instance, so this is one
 * shared definition of "safe test target," not a second, subtly different
 * one. No logic lives in this file; it exists so tests/e2e/ has its own
 * natural import path without duplicating the guard.
 */
export * from "../../integration/helpers/test-env";
