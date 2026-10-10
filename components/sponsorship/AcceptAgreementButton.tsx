"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { acceptMediaAgreementAction } from "@/lib/actions/sponsorship";

// The Sponsor's explicit act of accepting the campaign agreement. It sends only WHICH campaign: the document, its version and every commercial fact are resolved by the server.
export function AcceptAgreementButton({ sponsorshipId }: { sponsorshipId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1" data-slot="accept-agreement">
      <Button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await acceptMediaAgreementAction(sponsorshipId);
            setError(r.error);
            router.refresh();
          })
        }
      >
        I accept this agreement
      </Button>
      {error && (
        <p role="alert" className="text-xs font-medium text-warning-muted">
          {error}
        </p>
      )}
    </div>
  );
}
