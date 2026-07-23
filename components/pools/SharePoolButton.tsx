"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShareSheet } from "./ShareSheet";

// Icon-only to match the card footer's engagement-icon row (heart/comment/
// share, Instagram-style) — every pool gets a share affordance there now,
// not just HIDDEN ones behind a bordered "Share" button in the title row.
// Opens a bottom sheet with explicit platform targets (WhatsApp, Facebook,
// Email, Instagram, Copy Link, + native "More" when available) rather than
// going straight to the OS share sheet or clipboard, since those alone
// don't surface consistently across desktop/mobile browsers.
export function SharePoolButton({ poolId, question }: { poolId: string; question: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Share"
      >
        <Share2 className="size-5" aria-hidden="true" />
      </Button>

      {open && (
        <ShareSheet
          url={`${window.location.origin}/pool/${poolId}`}
          question={question}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
