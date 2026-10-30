import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Account-integrity behavior of registerAction (M9): the limiter verdicts (never fail open), the reserved-username list, and replacing an unused unconfirmed login that is squatting an address.

type Result = { data?: unknown; error?: { code?: string; message: string } | null };
const tables: Record<string, Result> = {};
const profileInsert = vi.fn<(row: unknown) => Result>();
const createUser = vi.fn();
const deleteUser = vi.fn();
const rpc = vi.fn();
const signIn = vi.fn();
const checkLimit = vi.fn();
const typeAsMember = vi.fn();
const recordAcceptance = vi.fn();
let forwarded: string | null = null;

vi.mock("next/headers", () => ({ headers: async () => new Headers(forwarded ? { "x-forwarded-for": forwarded } : {}) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signInWithPassword: signIn } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc,
    auth: { admin: { createUser, deleteUser } },
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => tables[table] ?? { data: null, error: null } }) }),
      insert: (row: unknown) => profileInsert(row),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));
vi.mock("@/lib/rate-limit/login", () => ({ checkLoginRateLimit: async () => true }));
vi.mock("@/lib/rate-limit/register", () => ({ checkRegisterRateLimit: (...args: unknown[]) => checkLimit(...args) }));
vi.mock("@/lib/legal/acceptance", () => ({ recordLegalAcceptance: (...args: unknown[]) => recordAcceptance(...args) }));
vi.mock("@/lib/auth/member-account", () => ({ typeAccountAsMember: (...args: unknown[]) => typeAsMember(...args) }));
vi.mock("@/lib/settings/registration", () => ({ getRegistrationEnabled: async () => true }));

const { registerAction } = await import("@/lib/actions/auth");

function form(over: Record<string, string> = {}) {
  const data = new FormData();
  const values: Record<string, string> = { email: "new@example.com", password: "correct-horse-9", username: "newbie", acceptedTerms: "on", ...over };
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}
const run = (over?: Record<string, string>) => registerAction({ error: null }, form(over)).catch((e: Error) => e.message);
const ALREADY = { data: { user: null }, error: { message: "A user with this email address has already been registered" } };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  forwarded = null;
  for (const m of [profileInsert, createUser, deleteUser, rpc, signIn, checkLimit, typeAsMember, recordAcceptance]) m.mockReset();
  checkLimit.mockResolvedValue("allowed");
  createUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  deleteUser.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: null, error: null });
  profileInsert.mockReturnValue({ error: null });
  signIn.mockResolvedValue({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.VERCEL;
});

describe("registerAction — rate limiting never fails open", () => {
  it("a refused budget creates nothing", async () => {
    checkLimit.mockResolvedValue("limited");
    expect(await run()).toEqual({ error: "Too many attempts. Please try again in a few minutes." });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("a limiter that cannot answer refuses the sign-up with a retry message, and creates nothing", async () => {
    checkLimit.mockResolvedValue("unavailable");
    expect(await run()).toEqual({ error: "We couldn't check this right now. Please try again in a minute." });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("hands the limiter the email and, on Vercel, the trusted client address", async () => {
    process.env.VERCEL = "1";
    forwarded = "203.0.113.9, 10.0.0.2";
    await run();
    expect(checkLimit).toHaveBeenCalledWith("new@example.com", "203.0.113.9");
  });

  it("passes no address off Vercel, where no header can be trusted", async () => {
    forwarded = "203.0.113.9";
    await run();
    expect(checkLimit).toHaveBeenCalledWith("new@example.com", null);
  });
});

describe("registerAction — reserved usernames", () => {
  it("refuses a reserved handle at its field before any login is created", async () => {
    tables.reserved_usernames = { data: { username: "admin" }, error: null };
    expect(await run({ username: "admin" })).toEqual({ error: null, fieldErrors: { username: "That username isn't available. Try another." } });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("still reports an ordinary taken handle as taken", async () => {
    tables.user_profiles = { data: { id: "x" }, error: null };
    expect(await run()).toEqual({ error: null, fieldErrors: { username: "That username is taken. Try another." } });
  });

  it("the database trigger is a backstop: a reserved-username refusal at profile insert removes the login and shows the same message", async () => {
    profileInsert.mockReturnValue({ error: { code: "23514", message: "reserved_username" } });
    expect(await run()).toEqual({ error: null, fieldErrors: { username: "That username isn't available. Try another." } });
    expect(deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("fails safe, not open, when the reserved list cannot be read", async () => {
    tables.reserved_usernames = { data: null, error: { message: "relation missing" } };
    expect(await run()).toEqual({ error: "Could not create your account. Try again." });
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe("registerAction — a password the provider refuses", () => {
  const weak = (reasons: string[]) => ({ data: { user: null }, error: { code: "weak_password", message: "Password is known to be weak and easy to guess, please choose a different one.", reasons } });

  it("a breached password is explained on the password field and creates nothing", async () => {
    createUser.mockResolvedValue(weak(["pwned"]));
    expect(await run({ password: "password123" })).toEqual({ error: null, fieldErrors: { password: "That password has appeared in a known data breach. Choose a different one." } });
    expect(profileInsert).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(typeAsMember).not.toHaveBeenCalled();
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("any other weak-password reason gets the plain wording", async () => {
    createUser.mockResolvedValue(weak(["characters"]));
    expect(await run()).toEqual({ error: null, fieldErrors: { password: "That password is too easy to guess. Choose a different one." } });
  });

  it("never echoes the password, and other create failures keep the generic message", async () => {
    createUser.mockResolvedValue(weak(["pwned"]));
    expect(JSON.stringify(await run({ password: "password123" }))).not.toContain("password123");
    createUser.mockResolvedValue({ data: { user: null }, error: { message: "database error" } });
    expect(await run()).toEqual({ error: "Could not create your account." });
  });
});

describe("registerAction — an unused unconfirmed login squatting the address", () => {
  it("is replaced, and the sign-up then proceeds", async () => {
    createUser.mockResolvedValueOnce(ALREADY);
    rpc.mockResolvedValueOnce({ data: "orphan-1", error: null });
    expect(await run()).toBe("REDIRECT:/feed");
    expect(rpc).toHaveBeenCalledWith("reclaimable_orphan_auth_user", { p_email: "new@example.com" });
    expect(deleteUser).toHaveBeenCalledWith("orphan-1");
    expect(createUser).toHaveBeenCalledTimes(2);
  });

  it("is never touched when the address belongs to a real account: same existing-account answer as before", async () => {
    createUser.mockResolvedValue(ALREADY);
    expect(await run()).toEqual({ error: null, fieldErrors: { email: "An account with this email already exists." }, existingAccount: true });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it("falls back to the existing-account answer if the orphan cannot be removed", async () => {
    createUser.mockResolvedValue(ALREADY);
    rpc.mockResolvedValueOnce({ data: "orphan-1", error: null });
    deleteUser.mockResolvedValueOnce({ error: { message: "nope" } });
    expect(await run()).toMatchObject({ existingAccount: true });
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it("replaces at most once: a second 'already registered' ends the attempt", async () => {
    createUser.mockResolvedValue(ALREADY);
    rpc.mockResolvedValue({ data: "orphan-1", error: null });
    expect(await run()).toMatchObject({ existingAccount: true });
    expect(createUser).toHaveBeenCalledTimes(2);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it("logs the opaque id of a replaced login, never the email", async () => {
    createUser.mockResolvedValueOnce(ALREADY);
    rpc.mockResolvedValueOnce({ data: "orphan-1", error: null });
    await run();
    const logged = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(logged).toContain("orphan-1");
    expect(logged).not.toContain("new@example.com");
  });
});
