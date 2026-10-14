import Link from "next/link";
import type { SharedObjectView } from "@/lib/messaging/share";

// A shared Brohda object, rendered as a structured card rather than a pasted URL. It is only ever built from what the server resolved FOR THIS VIEWER, so what is on screen is exactly what this
// Member is allowed to see. An object that is gone, or that the viewer may not see, is a calm placeholder, never an error.
export function SharedObjectCard({ view }: { view: SharedObjectView }) {
  if (view.state !== "ok") {
    return (
      <div data-slot="shared-object" data-state="unavailable" className="rounded-lg border border-dashed border-border-subtle px-3 py-2 text-sm text-text-muted">
        This isn&apos;t available.
      </div>
    );
  }
  const body = (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{view.label}</p>
      <p className="text-sm font-semibold text-text-primary">{view.title}</p>
      {view.detail && <p className="text-xs text-text-secondary">{view.detail}</p>}
    </>
  );
  return view.href ? (
    <Link
      href={view.href}
      data-slot="shared-object"
      data-type={view.type}
      className="block rounded-lg border border-border-subtle bg-background px-3 py-2 outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {body}
    </Link>
  ) : (
    <div data-slot="shared-object" data-type={view.type} className="rounded-lg border border-border-subtle bg-background px-3 py-2">
      {body}
    </div>
  );
}
