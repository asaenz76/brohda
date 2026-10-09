"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateSponsorProfileAction, type SponsorProfileState } from "@/lib/actions/sponsor-account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SponsorProfileState = { error: null };

interface Values {
  brandName: string;
  contactName: string;
  website: string;
  country: string;
  phone: string;
}

export function SponsorProfileForm({ initial, canEdit, brandLocked, logoLocked, logoMaxKb, sponsorId, logoUrl }: { initial: Values; canEdit: boolean; brandLocked: boolean; logoLocked: boolean; logoMaxKb: number | null; sponsorId: string; logoUrl: string | null }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(updateSponsorProfileAction, initialState);
  const [logoNote, setLogoNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const fe = state.fieldErrors ?? {};

  async function uploadLogo(file: File) {
    setUploading(true);
    setLogoNote(null);
    const body = new FormData();
    body.set("sponsorId", sponsorId);
    body.set("file", file);
    const res = await fetch("/api/sponsor/logo", { method: "POST", body }).catch(() => null);
    const json = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string };
    setUploading(false);
    if (res?.ok) {
      setLogoNote({ ok: true, text: "Logo saved." });
      router.refresh();
    } else {
      setLogoNote({ ok: false, text: json.error ?? "Could not upload the logo." });
    }
  }

  return (
    <div className="space-y-5">
      <section aria-label="Logo" className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Logo</h2>
        <div className="flex flex-wrap items-center gap-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Your logo" data-slot="sponsor-logo-preview" className="size-14 rounded-md bg-white object-contain p-0.5" />
          ) : (
            <span className="flex size-14 items-center justify-center rounded-md border border-dashed border-border-subtle text-[10px] text-text-muted">No logo</span>
          )}
          {!logoLocked && (
            <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Logo file" className="text-xs" onChange={(e) => e.target.files?.[0] && void uploadLogo(e.target.files[0])} disabled={uploading} />
              {logoMaxKb && <span className="text-xs text-text-muted">PNG, JPEG or WebP, up to {logoMaxKb} KB.</span>}
            </>
          )}
        </div>
        {logoNote && (
          <p role={logoNote.ok ? "status" : "alert"} className={logoNote.ok ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
            {logoNote.text}
          </p>
        )}
      </section>

      <form action={formAction} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="brandName">Brand or company name</Label>
          <Input id="brandName" name="brandName" defaultValue={initial.brandName} required maxLength={80} disabled={!canEdit || brandLocked} />
          {fe.brandName && <p role="alert" className="text-xs text-danger">{fe.brandName}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contactName">Contact person&apos;s name</Label>
          <Input id="contactName" name="contactName" defaultValue={initial.contactName} required maxLength={120} disabled={!canEdit} />
          {fe.contactName && <p role="alert" className="text-xs text-danger">{fe.contactName}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="website">Website</Label>
          <Input id="website" name="website" defaultValue={initial.website} maxLength={300} disabled={!canEdit} />
          {fe.website && <p role="alert" className="text-xs text-danger">{fe.website}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="country">Country</Label>
            <Input id="country" name="country" defaultValue={initial.country} maxLength={80} disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone / WhatsApp</Label>
            <Input id="phone" name="phone" defaultValue={initial.phone} maxLength={40} disabled={!canEdit} />
            {fe.phone && <p role="alert" className="text-xs text-danger">{fe.phone}</p>}
          </div>
        </div>
        {state.error && !Object.keys(fe).length && <p role="alert" className="text-sm text-danger">{state.error}</p>}
        {state.saved && <p role="status" className="text-sm font-medium text-text-primary">Profile saved.</p>}
        {canEdit && (
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save profile"}
          </Button>
        )}
      </form>
    </div>
  );
}
