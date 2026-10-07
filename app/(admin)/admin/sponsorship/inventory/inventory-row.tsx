"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setInventoryAction } from "@/lib/actions/admin-sponsorship";

export interface InventoryRowValues {
  isSponsorable: boolean;
  price: string;
  currency: string;
  startsAt: string;
  endsAt: string;
  marketCode: string;
}

export function InventoryRow({ postId, initial }: { postId: string; initial: InventoryRowValues }) {
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setMsg(null);
    startTransition(async () => {
      const r = await setInventoryAction({
        postId,
        marketCode: v.marketCode,
        isSponsorable: v.isSponsorable,
        priceCents: Math.round(Number(v.price) * 100),
        currency: v.currency,
        startsAt: new Date(`${v.startsAt}:00Z`).toISOString(),
        endsAt: new Date(`${v.endsAt}:00Z`).toISOString(),
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
        Starts (UTC)
        <Input className="mt-1 w-48" type="datetime-local" value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} />
      </label>
      <label>
        Ends (UTC)
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
    </div>
  );
}
