"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSponsorMemberAction, createSponsorAction, removeSponsorMemberAction, setSponsorStatusAction } from "@/lib/actions/admin-sponsorship";

interface Member {
  userId: string;
  displayName: string;
  email: string | null;
}
interface SponsorRow {
  id: string;
  displayName: string;
  legalName: string | null;
  contactEmail: string | null;
  status: string;
  logoUrl: string | null;
  members: Member[];
}
type Note = { ok: boolean; text: string } | null;

function Feedback({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p role={note.ok ? "status" : "alert"} className={note.ok ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
      {note.text}
    </p>
  );
}

function SponsorCard({ sponsor, logoMaxKb }: { sponsor: SponsorRow; logoMaxKb: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [logoNote, setLogoNote] = useState<Note>(null);
  const [memberNote, setMemberNote] = useState<Note>(null);
  const [statusNote, setStatusNote] = useState<Note>(null);
  const [email, setEmail] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadLogo() {
    if (!file) {
      setLogoNote({ ok: false, text: "Choose an image first." });
      return;
    }
    setUploading(true);
    setLogoNote(null);
    const body = new FormData();
    body.set("sponsorId", sponsor.id);
    body.set("file", file);
    const res = await fetch("/api/sponsor/logo", { method: "POST", body }).catch(() => null);
    const json = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string };
    setUploading(false);
    if (res?.ok) {
      setLogoNote({ ok: true, text: "Logo saved." });
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } else {
      setLogoNote({ ok: false, text: json.error ?? "Could not upload the logo." });
    }
  }

  return (
    <li className="space-y-3 rounded-lg border border-border-subtle p-3" data-sponsor-id={sponsor.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          {sponsor.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sponsor.logoUrl} alt={`${sponsor.displayName} logo`} data-slot="sponsor-logo-preview" className="size-10 rounded-md bg-white object-contain p-0.5" />
          ) : (
            <span className="flex size-10 items-center justify-center rounded-md border border-dashed border-border-subtle text-[10px] text-text-muted">No logo</span>
          )}
          <p className="text-sm font-medium text-text-primary">
            {sponsor.displayName}
            <span className="block text-xs font-normal text-text-muted">{sponsor.legalName ?? "—"}</span>
          </p>
        </div>
        <label className="text-xs text-text-muted">
          Status{" "}
          <select
            aria-label={`Status of ${sponsor.displayName}`}
            className="ml-1 rounded-md border border-border-subtle bg-background px-2 py-1 text-sm text-text-primary"
            value={sponsor.status}
            disabled={pending}
            onChange={(e) =>
              startTransition(async () => {
                const r = await setSponsorStatusAction(sponsor.id, e.target.value);
                setStatusNote({ ok: r.success, text: r.success ? "Status updated." : (r.error ?? "Could not update.") });
                if (r.success) router.refresh();
              })
            }
          >
            {["ACTIVE", "SUSPENDED", "DISABLED"].map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Feedback note={statusNote} />

      <section aria-label={`Logo for ${sponsor.displayName}`} className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Logo</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Logo file for ${sponsor.displayName}`} className="text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button type="button" variant="outline" disabled={uploading || !file} onClick={() => void uploadLogo()}>
            {uploading ? "Uploading…" : "Upload logo"}
          </Button>
        </div>
        <p className="text-xs text-text-muted">PNG, JPEG or WebP, up to {logoMaxKb} KB.</p>
        <Feedback note={logoNote} />
      </section>

      <section aria-label={`Members of ${sponsor.displayName}`} className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Members ({sponsor.members.length})</h3>
        {sponsor.members.length === 0 ? (
          <p className="text-xs text-text-muted">No members yet — nobody can sign in as this sponsor.</p>
        ) : (
          <ul className="space-y-1">
            {sponsor.members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
                <span>
                  {m.displayName} <span className="text-xs text-text-muted">{m.email ?? ""}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Remove ${m.displayName} from ${sponsor.displayName}`}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await removeSponsorMemberAction(sponsor.id, m.userId);
                      setMemberNote({ ok: r.success, text: r.success ? "Member removed." : (r.error ?? "Could not remove.") });
                      if (r.success) router.refresh();
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const r = await addSponsorMemberAction(sponsor.id, email);
              setMemberNote({ ok: r.success, text: r.success ? "Member added." : (r.error ?? "Could not add.") });
              if (r.success) {
                setEmail("");
                router.refresh();
              }
            });
          }}
        >
          <label className="text-xs text-text-muted">
            Add a member (the email of an existing account)
            <Input className="mt-1 w-64" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-label={`Member email for ${sponsor.displayName}`} />
          </label>
          <Button type="submit" variant="outline" disabled={pending}>
            Add member
          </Button>
        </form>
        <Feedback note={memberNote} />
      </section>

      <p className="text-xs text-text-muted">
        To give this sponsor a Game, open <Link href="/admin/sponsorship/inventory" className="font-medium text-accent-primary hover:underline">Inventory</Link>, mark the Game sponsorable and use “Assign to a sponsor”.
      </p>
    </li>
  );
}

export function SponsorsManager({ sponsors, logoMaxKb }: { sponsors: SponsorRow[]; logoMaxKb: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [name, setName] = useState("");
  const [legal, setLegal] = useState("");
  const [contact, setContact] = useState("");

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
              router.refresh();
            }
            setNote({ ok: r.success, text: r.success ? "Sponsor created. Add its logo and a member below." : (r.error ?? "Could not create.") });
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
        <Feedback note={note} />
      </form>
      {sponsors.length === 0 ? (
        <p className="text-sm text-text-muted">No sponsors yet.</p>
      ) : (
        <ul className="space-y-3">
          {sponsors.map((s) => (
            <SponsorCard key={s.id} sponsor={s} logoMaxKb={logoMaxKb} />
          ))}
        </ul>
      )}
    </div>
  );
}
