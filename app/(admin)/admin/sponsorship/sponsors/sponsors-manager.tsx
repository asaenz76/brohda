"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSponsorAction, setSponsorHiddenAction, setSponsorStatusAction } from "@/lib/actions/admin-sponsorship";

interface SponsorRow {
  id: string;
  displayName: string;
  legalName: string | null;
  contactEmail: string | null;
  contactName: string | null;
  contactPhone: string | null;
  website: string | null;
  country: string | null;
  status: string;
  statusReason: string | null;
  internalReviewNote: string | null;
  createdAt: string;
  logoUrl: string | null;
  /** The sponsor's one login; null for an organization Super Admin recorded by hand. */
  login: { email: string | null; emailVerified: boolean } | null;
  /** When this Sponsor was hidden from the normal list (admin-only; independent of status), or null. */
  hiddenAt: string | null;
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

const STATUS_LABEL: Record<string, string> = { PENDING_REVIEW: "Pending review", ACTIVE: "Active", REJECTED: "Rejected", SUSPENDED: "Suspended", DISABLED: "Disabled" };

// The moves Super Admin can make from each state (the database enforces the same table).
const TRANSITIONS: Record<string, Array<{ to: string; label: string }>> = {
  PENDING_REVIEW: [{ to: "ACTIVE", label: "Activate" }, { to: "REJECTED", label: "Reject" }, { to: "DISABLED", label: "Disable" }],
  ACTIVE: [{ to: "SUSPENDED", label: "Suspend" }, { to: "DISABLED", label: "Disable" }],
  REJECTED: [{ to: "ACTIVE", label: "Activate anyway" }, { to: "DISABLED", label: "Disable" }],
  SUSPENDED: [{ to: "ACTIVE", label: "Restore" }, { to: "DISABLED", label: "Disable" }],
  DISABLED: [{ to: "ACTIVE", label: "Restore" }],
};

function SponsorCard({ sponsor, logoMaxKb }: { sponsor: SponsorRow; logoMaxKb: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [logoNote, setLogoNote] = useState<Note>(null);
  const [statusNote, setStatusNote] = useState<Note>(null);
  const [visNote, setVisNote] = useState<Note>(null);
  const [confirmingHide, setConfirmingHide] = useState(false);
  const [reason, setReason] = useState("");
  const [internalNote, setInternalNote] = useState(sponsor.internalReviewNote ?? "");
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
    <li id={`sponsor-${sponsor.id}`} className="scroll-mt-4 space-y-3 rounded-lg border border-border-subtle p-3" data-sponsor-id={sponsor.id}>
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
        <span data-slot="sponsor-account-status" className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-text-primary">
          {STATUS_LABEL[sponsor.status] ?? sponsor.status}
        </span>
        {sponsor.hiddenAt && (
          <span data-slot="sponsor-hidden-badge" className="rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-text-muted">
            Hidden
          </span>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div><dt className="inline text-text-muted">Sign-in email: </dt><dd className="inline text-text-primary">{sponsor.login ? `${sponsor.login.email ?? "—"} (${sponsor.login.emailVerified ? "verified" : "not verified"})` : "No login — managed by Brohda"}</dd></div>
        <div><dt className="inline text-text-muted">Contact: </dt><dd className="inline text-text-primary">{sponsor.contactName ?? "—"}</dd></div>
        <div><dt className="inline text-text-muted">Phone: </dt><dd className="inline text-text-primary">{sponsor.contactPhone ?? "—"}</dd></div>
        <div><dt className="inline text-text-muted">Country: </dt><dd className="inline text-text-primary">{sponsor.country ?? "—"}</dd></div>
        <div className="sm:col-span-2"><dt className="inline text-text-muted">Website: </dt><dd className="inline text-text-primary">{sponsor.website ?? "—"}</dd></div>
        {sponsor.statusReason && <div className="sm:col-span-2"><dt className="inline text-text-muted">Reason shown to the sponsor: </dt><dd className="inline text-text-primary">{sponsor.statusReason}</dd></div>}
      </dl>
      <section aria-label={`Review ${sponsor.displayName}`} className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Account decision</h3>
        <label className="block text-xs text-text-muted">
          Reason (shown to the sponsor; required to reject, suspend or disable)
          <Input className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} aria-label={`Reason for ${sponsor.displayName}`} />
        </label>
        <label className="block text-xs text-text-muted">
          Internal note (never shown to the sponsor)
          <Input className="mt-1" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} maxLength={2000} aria-label={`Internal note for ${sponsor.displayName}`} />
        </label>
        <div className="flex flex-wrap gap-2">
          {(TRANSITIONS[sponsor.status] ?? []).map((t) => (
            <Button
              key={t.to}
              type="button"
              variant={t.to === "ACTIVE" ? "default" : "outline"}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await setSponsorStatusAction(sponsor.id, t.to, reason, internalNote);
                  setStatusNote({ ok: r.success, text: r.success ? "Status updated." : (r.error ?? "Could not update.") });
                  if (r.success) {
                    setReason("");
                    router.refresh();
                  }
                })
              }
            >
              {t.label}
            </Button>
          ))}
        </div>
      </section>
      <Feedback note={statusNote} />

      <section aria-label={`List visibility for ${sponsor.displayName}`} className="space-y-2" data-slot="sponsor-visibility">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Visibility in this list</h3>
        {sponsor.hiddenAt ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-text-secondary">Hidden from the normal Sponsors list. Its account status ({STATUS_LABEL[sponsor.status] ?? sponsor.status}) is unchanged.</p>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await setSponsorHiddenAction(sponsor.id, false);
                  setVisNote({ ok: r.success, text: r.success ? "Sponsor is visible again." : (r.error ?? "Could not unhide.") });
                  if (r.success) router.refresh();
                })
              }
            >
              Unhide sponsor
            </Button>
          </div>
        ) : confirmingHide ? (
          <div role="alertdialog" aria-label={`Hide ${sponsor.displayName}`} className="space-y-2 rounded-md border border-border-subtle p-3" data-slot="hide-confirm">
            <p className="text-sm font-medium text-text-primary">Hide this Sponsor from the normal Sponsors list?</p>
            <p className="text-xs text-text-secondary">This does not delete the Sponsor or change its account status.</p>
            {sponsor.status === "ACTIVE" && <p className="text-xs text-text-secondary">It is ACTIVE and stays ACTIVE: it can still sign in and operate, and its campaigns are unaffected. Hiding only affects this admin list.</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await setSponsorHiddenAction(sponsor.id, true);
                    setVisNote({ ok: r.success, text: r.success ? "Sponsor hidden." : (r.error ?? "Could not hide.") });
                    setConfirmingHide(false);
                    if (r.success) router.refresh();
                  })
                }
              >
                Hide
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmingHide(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmingHide(true)}>
            Hide sponsor
          </Button>
        )}
        <Feedback note={visNote} />
      </section>

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

      <p className="text-xs text-text-muted">
        To give this sponsor a Game, open <Link href="/admin/sponsorship/inventory" className="font-medium text-accent-primary hover:underline">Inventory</Link>, mark the Game sponsorable and use “Assign to a sponsor”.
      </p>
    </li>
  );
}

export function SponsorsManager({ sponsors, logoMaxKb, emptyText = "No sponsors yet." }: { sponsors: SponsorRow[]; logoMaxKb: number; emptyText?: string }) {
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
            setNote({ ok: r.success, text: r.success ? "Sponsor organization created (it has no login). Add its logo below." : (r.error ?? "Could not create.") });
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
          Create sponsor without a login
        </Button>
        <Feedback note={note} />
      </form>
      {sponsors.length === 0 ? (
        <p className="text-sm text-text-muted" data-slot="no-sponsors">{emptyText}</p>
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
