/**
 * Legal acceptance record: which version of the Terms / Privacy Policy a member accepted, when, and from where. Append-only; readable only
 * by the member; re-consent is OFF unless an owner switches it on, and a copy edit never forces it. Real local Supabase.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl, getTestSupabaseConfig } from "./helpers/test-env";
import { seedUser } from "./helpers/game-seed";
import { getPendingLegalAcceptances, recordLegalAcceptance } from "@/lib/legal/acceptance";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";

const admin = getTestAdminClient();
const original = { terms: LEGAL_DOCUMENTS.terms.version, privacy: LEGAL_DOCUMENTS.privacy.version };

afterEach(() => {
  LEGAL_DOCUMENTS.terms.version = original.terms;
  LEGAL_DOCUMENTS.privacy.version = original.privacy;
});

const rowsFor = async (userId: string) => (await admin.from("legal_acceptances").select("document, version, source, accepted_at").eq("user_id", userId).order("document")).data!;

describe("recording an acceptance", () => {
  it("stores the CURRENT version of both documents, when, and the source", async () => {
    const user = await seedUser("reg");
    const before = Date.now();
    await recordLegalAcceptance(user, "register");
    const rows = await rowsFor(user);
    expect(rows.map((r) => [r.document, r.version, r.source])).toEqual([
      ["privacy", original.privacy, "register"],
      ["terms", original.terms, "register"],
    ]);
    for (const r of rows) expect(new Date(r.accepted_at).getTime()).toBeGreaterThanOrEqual(before - 5000);
  });

  it("recording the same version again is a no-op, not an error and not a second row", async () => {
    const user = await seedUser("again");
    await recordLegalAcceptance(user, "register");
    await recordLegalAcceptance(user, "reconsent");
    expect(await rowsFor(user)).toHaveLength(2);
    expect((await rowsFor(user)).every((r) => r.source === "register")).toBe(true); // the first record stands
  });

  it("a new version is a new row beside the old one — history is kept", async () => {
    const user = await seedUser("hist");
    await recordLegalAcceptance(user, "register");
    LEGAL_DOCUMENTS.terms.version = "2099-01-01";
    await recordLegalAcceptance(user, "reconsent", ["terms"]);
    const terms = (await rowsFor(user)).filter((r) => r.document === "terms");
    expect(terms.map((r) => [r.version, r.source]).sort()).toEqual([["2099-01-01", "reconsent"], [original.terms, "register"]].sort());
  });

  it("a source outside the allowed set is refused by the database", async () => {
    const user = await seedUser("src");
    const { error } = await admin.from("legal_acceptances").insert({ user_id: user, document: "terms", version: "x", source: "forged" });
    expect(error).not.toBeNull();
  });
});

describe("it is a record, not a setting: append-only, and private", () => {
  it("UPDATE and DELETE are refused — by privilege for the service role, and by the append-only trigger even for a superuser", async () => {
    const user = await seedUser("append");
    await recordLegalAcceptance(user, "register");
    const update = await admin.from("legal_acceptances").update({ version: "forged" }).eq("user_id", user);
    expect(update.error?.message).toMatch(/permission denied|append-only/);
    const del = await admin.from("legal_acceptances").delete().eq("user_id", user);
    expect(del.error?.message).toMatch(/permission denied|append-only/);
    // The trigger is the last line of defence: it refuses even a connection that holds every privilege.
    const pg = new Client({ connectionString: getTestDatabaseUrl() });
    await pg.connect();
    try {
      await expect(pg.query("update public.legal_acceptances set version = 'forged' where user_id = $1", [user])).rejects.toThrow(/append-only/);
      await expect(pg.query("delete from public.legal_acceptances where user_id = $1", [user])).rejects.toThrow(/append-only/);
    } finally {
      await pg.end();
    }
    expect(await rowsFor(user)).toHaveLength(2);
  });

  it("a member can read only their own acceptances, and nobody can write through the client", async () => {
    const { url, anonKey } = getTestSupabaseConfig();
    const emailOf = async (id: string) => (await admin.auth.admin.getUserById(id)).data.user!.email!;
    const a = await seedUser("owner");
    const b = await seedUser("other");
    await recordLegalAcceptance(a, "register");
    await recordLegalAcceptance(b, "register");
    const client = createSupabaseClient(url, anonKey);
    const { error: signInError } = await client.auth.signInWithPassword({ email: await emailOf(a), password: "integration-test-password-123" });
    if (signInError) throw signInError;
    const mine = await client.from("legal_acceptances").select("user_id");
    expect(new Set((mine.data ?? []).map((r) => r.user_id))).toEqual(new Set([a]));
    const insert = await client.from("legal_acceptances").insert({ user_id: a, document: "terms", version: "forged", source: "register" });
    expect(insert.error).not.toBeNull();
    const anon = createSupabaseClient(url, anonKey);
    expect((await anon.from("legal_acceptances").select("id")).data ?? []).toEqual([]);
  });
});

describe("re-consent is a deliberate switch, and off by default", () => {
  it("by default nothing is pending — not even for a member with no record at all (existing members are never forced)", async () => {
    const user = await seedUser("legacy");
    expect(await getPendingLegalAcceptances(user)).toEqual([]);
  });

  it("when an owner requires it, exactly the documents whose CURRENT version the member hasn't accepted are pending", async () => {
    const user = await seedUser("needs");
    await admin.from("platform_settings").update({ legal_reconsent_required: ["terms"] }).eq("id", true);
    expect(await getPendingLegalAcceptances(user)).toEqual(["terms"]);
    await recordLegalAcceptance(user, "reconsent", ["terms"]);
    expect(await getPendingLegalAcceptances(user)).toEqual([]);
    // A later version of the same document is pending again; privacy was never required, so it never is.
    LEGAL_DOCUMENTS.terms.version = "2099-06-01";
    expect(await getPendingLegalAcceptances(user)).toEqual(["terms"]);
  });

  it("requires both when both are listed, in a stable order", async () => {
    const user = await seedUser("both");
    await admin.from("platform_settings").update({ legal_reconsent_required: ["privacy", "terms"] }).eq("id", true);
    expect(await getPendingLegalAcceptances(user)).toEqual(["terms", "privacy"]);
  });

  it("only terms/privacy can be listed", async () => {
    const { error } = await admin.from("platform_settings").update({ legal_reconsent_required: ["cookies"] }).eq("id", true);
    expect(error).not.toBeNull();
  });
});

