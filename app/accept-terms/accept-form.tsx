"use client";

import { useActionState } from "react";
import Link from "next/link";
import { acceptLegalUpdateAction, type AcceptLegalState } from "@/lib/actions/legal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const initialState: AcceptLegalState = { error: null };

export function AcceptLegalForm({ next, documents }: { next: string | null; documents: Array<{ key: "terms" | "privacy"; name: string; effectiveDate: string }> }) {
  const [state, formAction, pending] = useActionState(acceptLegalUpdateAction, initialState);
  return (
    <form action={formAction} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <ul className="space-y-1 text-sm text-text-secondary">
        {documents.map((doc) => (
          <li key={doc.key}>
            <Link href={`/${doc.key}`} target="_blank" className="font-medium text-text-primary underline underline-offset-4">
              {doc.name}
            </Link>{" "}
            <span className="text-text-muted">(effective {doc.effectiveDate})</span>
          </li>
        ))}
      </ul>
      <div className="flex items-start gap-2">
        <Checkbox id="accepted" name="accepted" required className="mt-0.5" />
        <Label htmlFor="accepted" className="text-sm font-normal text-text-secondary">
          I have read and agree to the updated {documents.map((d) => d.name).join(" and ")}.
        </Label>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Agree and continue"}
      </Button>
    </form>
  );
}
