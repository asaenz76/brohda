"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { assignSponsorshipAction, setInventoryAction } from "@/lib/actions/admin-sponsorship";
import { isoToLocalInput, localInputToIso, viewerTimeZone } from "@/lib/sponsorship/local-datetime";

export interface InventoryRowValues {
  isSponsorable: boolean;
  price: string;
  currency: string;
  /** ISO instants (UTC). Shown and edited in the admin's own time zone. */
  startsAt: string;
  endsAt: string;
  marketCode: string;
}

export interface AssignableSponsor {
  id: string;
  displayName: string;
}

export function InventoryRow({
  postId,
  initial,
  inventoryId,
  held,
  sponsors,
  gameName,
}: {
  postId: string;
  initial: InventoryRowValues;
  /** The saved inventory row's id (null until the Game has been saved as inventory). */
  inventoryId: string | null;
  /** Something already holds this Game (submitted / scheduled / live / suspended) — it cannot be assigned. */
  held: boolean;
  sponsors: AssignableSponsor[];
  gameName: string;
}) {
  // The window fields hold the viewer-LOCAL text a datetime-local input needs. They are filled after mount (the server cannot know the viewer's time zone, so
  // rendering them on the server would hydrate to a different value), and saved back as instants.
  const [v, setV] = useState({ ...initial, startsAt: "", endsAt: "" });
  const [zone, setZone] = useState("");
  useEffect(() => {
    // Deliberate: the viewer's real time zone is only knowable after mount (the same hydration-safe pattern as components/LocalDateTime.tsx).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setV((current) => ({ ...current, startsAt: isoToLocalInput(initial.startsAt), endsAt: isoToLocalInput(initial.endsAt) }));
    setZone(viewerTimeZone());
  }, [initial.startsAt, initial.endsAt]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [sponsorId, setSponsorId] = useState("");
  const [assignMsg, setAssignMsg] = useState<{ ok: boolean; text: string; id?: string } | null>(null);

  function save() {
    setMsg(null);
    const startsAt = localInputToIso(v.startsAt);
    const endsAt = localInputToIso(v.endsAt);
    if (!startsAt || !endsAt) {
      setMsg({ ok: false, text: "Enter a valid start and end." });
      return;
    }
    startTransition(async () => {
      const r = await setInventoryAction({
        postId,
        marketCode: v.marketCode,
        isSponsorable: v.isSponsorable,
        priceCents: Math.round(Number(v.price) * 100),
        currency: v.currency,
        startsAt,
        endsAt,
      });
      setMsg({ ok: r.success, text: r.success ? "Saved." : (r.error ?? "Could not save.") });
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2 text-xs text-text-muted">
      <label className="flex items-center gap-1.5 text-sm text-text-primary">
        <input type="checkbox" checked={v.isSponsorable} onChange={(e) => setV({ ...v, isSponsorable: e.target.checked })} /> Sponsorable
      </label>
      <label>
        Price
        <Input className="mt-1 w-24" inputMode="decimal" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} />
      </label>
      <label>
        Currency
        <Input className="mt-1 w-16 uppercase" maxLength={3} value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} />
      </label>
      <label>
        Market
        <Input className="mt-1 w-24 uppercase" value={v.marketCode} onChange={(e) => setV({ ...v, marketCode: e.target.value })} />
      </label>
      <label>
        Starts{zone ? ` (${zone})` : ""}
        <Input className="mt-1 w-48" type="datetime-local" value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} />
      </label>
      <label>
        Ends{zone ? ` (${zone})` : ""}
        <Input className="mt-1 w-48" type="datetime-local" value={v.endsAt} onChange={(e) => setV({ ...v, endsAt: e.target.value })} />
      </label>
      <Button type="button" variant="outline" disabled={pending} onClick={save}>
        Save
      </Button>
      {msg && (
        <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-text-primary" : "text-warning-muted"}>
          {msg.text}
        </span>
      )}
      {inventoryId && initial.isSponsorable && !held && (
        <div className="flex w-full flex-wrap items-end gap-2 border-t border-border-subtle pt-2">
          {sponsors.length === 0 ? (
            <p className="text-xs text-text-muted">
              Create an active sponsor under <Link href="/admin/sponsorship/sponsors" className="font-medium text-accent-primary hover:underline">Sponsors</Link> to assign this Game.
            </p>
          ) : (
            <>
              <label className="text-xs text-text-muted">
                Assign to a sponsor
                <select
                  aria-label={`Sponsor for ${gameName}`}
                  className="mt-1 block rounded-md border border-border-subtle bg-background px-2 py-2 text-sm text-text-primary"
                  value={sponsorId}
                  onChange={(e) => setSponsorId(e.target.value)}
                >
                  <option value="">Choose a sponsor…</option>
                  {sponsors.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                disabled={pending || !sponsorId}
                aria-label={`Assign ${gameName} to the chosen sponsor`}
                onClick={() => {
                  setAssignMsg(null);
                  startTransition(async () => {
                    const r = await assignSponsorshipAction(sponsorId, inventoryId, gameName);
                    setAssignMsg({ ok: r.success, text: r.success ? "Assigned — the sponsor now has it as a draft." : (r.error ?? "Could not assign."), id: r.id });
                  });
                }}
              >
                Assign
              </Button>
              <p className="basis-full text-xs text-text-muted">The sponsor completes the details and submits; nothing is public until it is paid and you approve it.</p>
            </>
          )}
          {assignMsg && (
            <span role={assignMsg.ok ? "status" : "alert"} className={assignMsg.ok ? "text-xs text-text-primary" : "text-xs text-warning-muted"}>
              {assignMsg.text}{" "}
              {assignMsg.ok && assignMsg.id && (
                <Link href={`/admin/sponsorship/${assignMsg.id}`} className="font-medium text-accent-primary hover:underline">
                  Open it
                </Link>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
