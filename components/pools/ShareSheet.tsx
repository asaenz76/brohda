"use client";

import { useEffect, useRef, useState } from "react";
import { Mail, Link2, Check, MoreHorizontal } from "lucide-react";

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 fill-white" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
      <path d="M12.012 2C6.505 2 2.033 6.472 2.033 11.98c0 1.913.531 3.696 1.416 5.221L2 22l4.938-1.293a9.943 9.943 0 0 0 5.074 1.387c5.507 0 9.978-4.472 9.978-9.98C21.99 6.473 17.518 2 12.012 2zm0 18.164a8.15 8.15 0 0 1-4.153-1.135l-.298-.177-2.929.768.782-2.855-.194-.293a8.146 8.146 0 0 1-1.253-4.352c0-4.508 3.669-8.176 8.177-8.176 4.508 0 8.176 3.668 8.176 8.176 0 4.508-3.668 8.176-8.176 8.176z" />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 fill-white" aria-hidden="true">
      <path d="M13.5 22v-8.5h2.85l.43-3.31H13.5V8.05c0-.96.267-1.61 1.64-1.61h1.75V3.48A23.4 23.4 0 0 0 14.36 3.3c-2.51 0-4.23 1.532-4.23 4.346V10.2H7.27v3.31h2.86V22h3.37z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 fill-white" aria-hidden="true">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.058-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.667.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
    </svg>
  );
}

type ShareOption = {
  label: string;
  bg: string;
  icon: React.ReactNode;
  action: () => void;
};

// Instagram-esque bottom sheet: a row of circular, brand-colored icon
// bubbles + labels underneath, echoing components/feed/StoriesRow.tsx's
// visual language rather than a plain text list. Mirrors
// EntryConfirmationSheet.tsx/CommentSheet.tsx's focus-trapped bottom-sheet
// shape.
export function ShareSheet({
  url,
  question,
  onClose,
}: {
  url: string;
  question: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [instagramHint, setInstagramHint] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;

      const focusables = sheetRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent(question);

  // navigator.clipboard.writeText can legitimately reject (permissions-
  // policy-restricted embeds, an unfocused tab, older browsers) — returns
  // false instead of throwing so callers can show a real error state
  // rather than silently doing nothing.
  async function copyLink(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      setCopyError(true);
      setTimeout(() => setCopyError(false), 2500);
      return false;
    }
  }

  const options: ShareOption[] = [
    {
      label: "WhatsApp",
      bg: "bg-[#25D366]",
      icon: <WhatsAppIcon />,
      action: () => {
        window.open(`https://wa.me/?text=${encodedText}%20${encodedUrl}`, "_blank", "noopener,noreferrer");
        onClose();
      },
    },
    {
      label: "Facebook",
      bg: "bg-[#1877F2]",
      icon: <FacebookIcon />,
      action: () => {
        window.open(
          `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
          "_blank",
          "noopener,noreferrer",
        );
        onClose();
      },
    },
    {
      label: "Email",
      bg: "bg-text-muted",
      icon: <Mail className="size-6 text-white" aria-hidden="true" />,
      action: () => {
        window.location.href = `mailto:?subject=${encodedText}&body=${encodedUrl}`;
        onClose();
      },
    },
    {
      label: "Instagram",
      bg: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af]",
      icon: <InstagramIcon />,
      action: async () => {
        // No web share URL exists for arbitrary links on Instagram — copy
        // the link and tell the user to paste it into a Story or DM,
        // rather than silently doing nothing or bouncing them out of the
        // app to no effect.
        const ok = await copyLink();
        if (!ok) return;
        setInstagramHint(true);
        setTimeout(() => setInstagramHint(false), 2500);
      },
    },
    {
      label: copied ? "Copied!" : "Copy Link",
      bg: "bg-surface-secondary",
      icon: copied ? (
        <Check className="size-6 text-credit" aria-hidden="true" />
      ) : (
        <Link2 className="size-6 text-text-primary" aria-hidden="true" />
      ),
      action: async () => {
        const ok = await copyLink();
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
    },
  ];

  if (typeof navigator.share === "function") {
    options.push({
      label: "More",
      bg: "bg-surface-secondary",
      icon: <MoreHorizontal className="size-6 text-text-primary" aria-hidden="true" />,
      action: async () => {
        try {
          await navigator.share({ title: question, url });
          onClose();
        } catch {
          // User cancelled the OS share sheet — stay open.
        }
      },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Share"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[720px] space-y-4 rounded-t-2xl bg-surface-primary p-5 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-subtle" aria-hidden="true" />

        <p className="text-sm font-semibold text-text-primary">Share</p>

        <div className="flex flex-wrap gap-4">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={option.action}
              className="flex w-16 flex-col items-center gap-1.5"
            >
              <span
                className={`flex size-14 items-center justify-center rounded-full ${option.bg}`}
              >
                {option.icon}
              </span>
              <span className="max-w-16 truncate text-xs text-text-secondary">{option.label}</span>
            </button>
          ))}
        </div>

        {instagramHint && (
          <p role="status" className="text-xs text-text-muted">
            Link copied — paste it into your Instagram Story or DM.
          </p>
        )}

        {copyError && (
          <p role="alert" className="text-xs text-danger">
            Could not copy the link. Try again.
          </p>
        )}
      </div>
    </div>
  );
}
