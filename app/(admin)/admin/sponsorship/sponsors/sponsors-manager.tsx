"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSponsorMemberAction, createSponsorAction, setSponsorStatusAction } from "@/lib/actions/admin-sponsorship";

interface SponsorRow {
  id: string;
  displayName: string;
  legalName: string | null;
  contactEmail: string | null;
  status: string;
  memberCount: number;
  logoUrl: string | null;
}

export function SponsorsManager({ sponsors }: { sponsors: SponsorRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState("");
  const [legal, setLegal] = useState("");
  const [contact, setContact] = useState("");
  const [memberEmail, setMemberEmail] = useState<Record<string, string>>({});

  const done = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    if (ok) router.refresh();
  };

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-2 rounded-lg border border-border-subtle p-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const r = await createSponsorAction({ displayName: name, legalName: legal, contactEmail: contact });
            if (r.success) {
              setName("");
              setLegal("");
              setContact("");
            }
            done(r.success, r.success ? "Sponsor created." : (r.error ?? "Could not create."));
          });
        }}
      >
        <label className="text-xs text-text-muted">
          Display name
          <Input className="mt-1 w-48" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </label>
        <label className="text-xs text-text-muted">
          Legal name (optional)
          <Input className="mt-1 w-48" value={legal} onChange={(e) => setLegal(e.target.value)} maxLength={160} />
        </label>
        <label className="text-xs text-text-muted">
          Contact email (optional)
          <Input className="mt-1 w-56" type="email" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={254} />
        </label>
        <Button type="submit" disabled={pending}>
          Create sponsor
        </Button>
      </form>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm font-medium text-text-primary" : "text-sm font-medium text-warning-muted"}>
          {msg.text}
        </p>
      )}
      {sponsors.length === 0 ? (
        <p className="text-sm text-text-muted">No sponsors yet.</p>
      ) : (
        <ul className="space-y-2">
          {sponsors.map((s) => (
            <li key={s.id} className="space-y-2 rounded-lg border border-border-subtle p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-text-primary">
                  {s.displayName} <span className="text-xs font-normal text-text-muted">{s.legalName ? `· ${s.legalName}` : ""} · {s.memberCount} member{s.memberCount === 1 ? "" : "s"}</span>
                </p>
                <label className="text-xs text-text-muted">
                  Status{" "}
                  <select
                    aria-label={`Status of ${s.displayName}`}
                    className="ml-1 rounded-md border border-border-subtle bg-background px-2 py-1 text-sm text-text-primary"
                    value={s.status}
                    disabled={pending}
                    onChange={(e) => startTransition(async () => { const r = await setSponsorStatusAction(s.id, e.target.value); done(r.success, r.success ? "Status updated." : (r.error ?? "Could not update.")); })}
                  >
                    {["ACTIVE", "SUSPENDED", "DISABLED"].map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  startTransition(async () => {
                    const r = await addSponsorMemberAction(s.id, memberEmail[s.id] ?? "");
                    if (r.success) setMemberEmail((m) => ({ ...m, [s.id]: "" }));
                    done(r.success, r.success ? "Member added." : (r.error ?? "Could not add."));
                  });
                }}
              >
                <label className="text-xs text-text-muted">
                  Add a member (existing account email)
                  <Input className="mt-1 w-64" type="email" value={memberEmail[s.id] ?? ""} onChange={(e) => setMemberEmail((m) => ({ ...m, [s.id]: e.target.value }))} />
                </label>
                <Button type="submit" variant="outline" disabled={pending}>
                  Add member
                </Button>
                <label className="text-xs text-text-muted">
                  Logo
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="mt-1 block text-xs"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const body = new FormData();
                      body.set("sponsorId", s.id);
                      body.set("file", file);
                      const res = await fetch("/api/sponsor/logo", { method: "POST", body });
                      const json = (await res.json().catch(() => ({}))) as { error?: string };
                      done(res.ok, res.ok ? "Logo updated." : (json.error ?? "Could not upload."));
                    }}
                  />
                </label>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
