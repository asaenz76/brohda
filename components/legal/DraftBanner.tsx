// The unmissable marker on any legal text engineering wrote that counsel/owner has not approved. Never reads as "final" or "approved".
export function DraftBanner({ what }: { what: string }) {
  return (
    <div role="note" data-slot="draft-banner" className="mb-6 rounded-lg border border-warning-muted bg-secondary p-3 text-sm text-text-primary">
      <p className="font-semibold">DRAFT — OWNER/COUNSEL REVIEW REQUIRED</p>
      <p className="mt-1 text-text-secondary">
        This {what} is a working draft written to describe how sponsorships operate. It has not been reviewed or approved by counsel, it is not final, and no one is asked to accept it yet.
      </p>
    </div>
  );
}
