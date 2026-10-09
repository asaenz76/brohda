"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cancelSponsorshipAction, saveSponsorshipDraftAction, submitSponsorshipAction } from "@/lib/actions/sponsorship";
import { saveSponsorshipAsAdminAction, submitSponsorshipAsAdminAction } from "@/lib/actions/admin-sponsorship";

export interface EditorValues {
  campaignName: string;
  presentedBy: string;
  tagline: string;
  ctaText: string;
  destinationUrl: string;
  hasPromotion: boolean;
  promotionTitle: string;
  promotionDescription: string;
  prizeDescription: string;
  officialRulesUrl: string;
  promotionDestinationUrl: string;
  promotionFulfillmentName: string;
  promotionEligibilitySummary: string;
  promotionStartsAt: string;
  promotionEndsAt: string;
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-warning-muted">
          {error}
        </p>
      )}
    </div>
  );
}

export function SponsorshipEditor({
  sponsorshipId,
  sponsorId,
  initial,
  logoUrl,
  canCancel,
  logoMaxKb,
  mode = "sponsor",
}: {
  sponsorshipId: string;
  sponsorId: string;
  initial: EditorValues;
  logoUrl: string | null;
  canCancel: boolean;
  logoMaxKb: number;
  /** "admin": Super Admin completing the sponsorship on the sponsor's behalf (same fields and rules; a different, Super-Admin-only server action). */
  mode?: "sponsor" | "admin";
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [logo, setLogo] = useState(logoUrl);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof EditorValues>(key: K, value: EditorValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  function run(kind: "save" | "submit") {
    setMessage(null);
    setFieldErrors({});
    startTransition(async () => {
      const save = mode === "admin" ? saveSponsorshipAsAdminAction : saveSponsorshipDraftAction;
      const submit = mode === "admin" ? submitSponsorshipAsAdminAction : submitSponsorshipAction;
      const result = kind === "save" ? await save(sponsorshipId, values) : await submit(sponsorshipId, values);
      setFieldErrors(result.fieldErrors ?? {});
      setMessage({ ok: result.success, text: result.success ? (kind === "save" ? "Draft saved." : mode === "admin" ? "Submitted on the sponsor's behalf. Record the payment and approve below." : "Submitted. Brohda will confirm payment and review it.") : (result.error ?? "Something went wrong.") });
      if (result.success) router.refresh();
    });
  }

  async function uploadLogo(file: File) {
    setMessage(null);
    const body = new FormData();
    body.set("sponsorId", sponsorId);
    body.set("file", file);
    const response = await fetch("/api/sponsor/logo", { method: "POST", body });
    const json = (await response.json().catch(() => ({}))) as { error?: string; logoPath?: string };
    if (!response.ok) {
      setMessage({ ok: false, text: json.error ?? "Could not upload the logo." });
      return;
    }
    setMessage({ ok: true, text: "Logo uploaded. Save the draft to use it." });
    router.refresh();
    if (fileRef.current) fileRef.current.value = "";
    setLogo(URL.createObjectURL(file));
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run("submit");
      }}
    >
      <Field id="campaignName" label="Campaign name (private)" error={fieldErrors.campaignName}>
        <Input id="campaignName" value={values.campaignName} maxLength={120} onChange={(e) => set("campaignName", e.target.value)} />
      </Field>
      <Field id="presentedBy" label="Name shown to members" hint="Shown as “Presented by …”." error={fieldErrors.presentedBy}>
        <Input id="presentedBy" value={values.presentedBy} maxLength={80} onChange={(e) => set("presentedBy", e.target.value)} />
      </Field>
      <div className="space-y-1">
        <Label htmlFor="logo">Logo</Label>
        <div className="flex items-center gap-3">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="Current sponsor logo" className="size-10 rounded-md bg-white object-contain p-0.5" />
          ) : (
            <span className="text-xs text-text-muted">No logo yet</span>
          )}
          <input id="logo" ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="text-xs" onChange={(e) => e.target.files?.[0] && void uploadLogo(e.target.files[0])} />
        </div>
        <p className="text-xs text-text-muted">PNG, JPEG or WebP, up to {logoMaxKb} KB. The logo belongs to your sponsor account.</p>
      </div>
      <Field id="tagline" label="Short line (optional)" error={fieldErrors.tagline}>
        <Input id="tagline" value={values.tagline} maxLength={140} onChange={(e) => set("tagline", e.target.value)} />
      </Field>
      <Field id="destinationUrl" label="Destination link" hint="Where the call to action sends members. https:// only." error={fieldErrors.destinationUrl}>
        <Input id="destinationUrl" type="url" inputMode="url" value={values.destinationUrl} onChange={(e) => set("destinationUrl", e.target.value)} />
      </Field>
      <Field id="ctaText" label="Call-to-action text (optional)" hint="For example “Learn more”." error={fieldErrors.ctaText}>
        <Input id="ctaText" value={values.ctaText} maxLength={30} onChange={(e) => set("ctaText", e.target.value)} />
      </Field>

      <fieldset className="space-y-3 rounded-lg border border-border-subtle p-3">
        <legend className="px-1 text-sm font-medium text-text-primary">Sponsor-run promotion (optional)</legend>
        <label className="flex items-start gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={values.hasPromotion} onChange={(e) => set("hasPromotion", e.target.checked)} className="mt-1" />
          <span>
            Include a promotion or prize. <strong className="font-medium text-text-primary">You run it, not Brohda</strong> — Brohda shows the details and a link to your official rules, and does not take entries, choose winners, hold prizes or deliver them.
          </span>
        </label>
        {values.hasPromotion && (
          <div className="space-y-3">
            <Field id="promotionTitle" label="Promotion title" error={fieldErrors.promotionTitle}>
              <Input id="promotionTitle" value={values.promotionTitle} maxLength={120} onChange={(e) => set("promotionTitle", e.target.value)} />
            </Field>
            <Field id="promotionDescription" label="Description" error={fieldErrors.promotionDescription}>
              <Input id="promotionDescription" value={values.promotionDescription} maxLength={600} onChange={(e) => set("promotionDescription", e.target.value)} />
            </Field>
            <Field id="prizeDescription" label="Prize" error={fieldErrors.prizeDescription}>
              <Input id="prizeDescription" value={values.prizeDescription} maxLength={300} onChange={(e) => set("prizeDescription", e.target.value)} />
            </Field>
            <Field id="officialRulesUrl" label="Official rules link" hint="Required. https:// only." error={fieldErrors.officialRulesUrl}>
              <Input id="officialRulesUrl" type="url" inputMode="url" value={values.officialRulesUrl} onChange={(e) => set("officialRulesUrl", e.target.value)} />
            </Field>
            <Field id="promotionFulfillmentName" label="Who runs the promotion" hint="You, or the third-party administrator." error={fieldErrors.promotionFulfillmentName}>
              <Input id="promotionFulfillmentName" value={values.promotionFulfillmentName} maxLength={160} onChange={(e) => set("promotionFulfillmentName", e.target.value)} />
            </Field>
            <Field id="promotionEligibilitySummary" label="Who can enter (short summary)" error={fieldErrors.promotionEligibilitySummary}>
              <Input id="promotionEligibilitySummary" value={values.promotionEligibilitySummary} maxLength={300} onChange={(e) => set("promotionEligibilitySummary", e.target.value)} />
            </Field>
          </div>
        )}
      </fieldset>

      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm font-medium text-text-primary" : "text-sm font-medium text-warning-muted"}>
          {message.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => run("save")}>
          Save draft
        </Button>
        <Button type="submit" disabled={pending}>
          {mode === "admin" ? "Submit on the sponsor's behalf" : "Submit for review"}
        </Button>
        {canCancel && mode === "sponsor" && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await cancelSponsorshipAction(sponsorshipId);
                if (r.success) router.push("/sponsor");
                else setMessage({ ok: false, text: r.error ?? "Could not cancel." });
              })
            }
          >
            Cancel sponsorship
          </Button>
        )}
      </div>
    </form>
  );
}
