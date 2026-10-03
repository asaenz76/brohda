"use client";

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// The accessible bottom sheet behind both mobile "menu" buttons (the
// logged-out front door's hamburger and the signed-in bottom bar's Menu).
// @base-ui's Dialog supplies the modal behaviour: focus is trapped in the
// sheet, Escape and the backdrop close it, and focus returns to the
// trigger. `children` is a render function so a link can close the sheet
// when followed.
export function MenuSheet({
  triggerLabel,
  triggerClassName,
  triggerContent,
  popupTestId,
  children,
}: {
  triggerLabel: string;
  triggerClassName?: string;
  triggerContent: React.ReactNode;
  popupTestId: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger aria-label={triggerLabel} className={triggerClassName}>
        {triggerContent}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup
          data-testid={popupTestId}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-xl border-t border-border-subtle bg-background px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none",
          )}
        >
          <div className="flex items-center justify-between px-3">
            <Dialog.Title className="text-base font-semibold text-text-primary">Menu</Dialog.Title>
            <Dialog.Close
              aria-label="Close menu"
              className="flex size-11 items-center justify-center rounded-md text-text-secondary outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children(close)}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Row styling shared by every link/button inside a MenuSheet. */
export const menuItemClass =
  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-text-primary outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50";
