"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { listShareChoicesAction, sendMessageAction, shareObjectAction, type MessagingActionResult, type ShareChoice } from "@/lib/actions/messaging";
import { remainingCharacters } from "@/lib/messaging/text";
import type { ShareType } from "@/lib/messaging/share";

// The text box. It never shows a message as sent until the SERVER confirms it: on a failure the text stays where it is and the retry reuses the same de-duplication key, so a network retry can
// never produce two messages. The remaining-character count and the empty check are UX only; the database enforces the real rules.
export function Composer({
  recipientId,
  maxLength,
  placeholder = "Write a message",
  autoFocus = false,
  onSent,
}: {
  recipientId: string;
  maxLength: number;
  placeholder?: string;
  autoFocus?: boolean;
  onSent: (result: MessagingActionResult) => void;
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // One key per compose attempt: kept across a failed send (so a retry is safe) and replaced only after the server accepted it.
  const key = useRef<string>("");
  const ensureKey = () => (key.current ||= crypto.randomUUID());

  const left = remainingCharacters(text, maxLength);
  const canSend = !pending && text.trim().length > 0 && left >= 0;

  function submit() {
    if (!canSend) return;
    const idempotencyKey = ensureKey();
    startTransition(async () => {
      const r = await sendMessageAction({ recipientId, body: text, idempotencyKey });
      setStatus(r.ok ? null : r.message);
      if (r.ok) {
        setText("");
        key.current = "";
        onSent(r);
      }
    });
  }

  return (
    <div data-slot="composer" className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="message-text" className="sr-only">
            Message
          </label>
          <Textarea
            id="message-text"
            value={text}
            autoFocus={autoFocus}
            rows={2}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            aria-describedby="message-help"
            className="min-h-12 resize-none"
          />
        </div>
        <Button type="button" variant="outline" size="icon-lg" aria-label="Share a Game, Market, Pick or Call BS" aria-expanded={shareOpen} onClick={() => setShareOpen((v) => !v)}>
          <Paperclip aria-hidden="true" />
        </Button>
        <Button type="button" size="lg" disabled={!canSend} onClick={submit} aria-label="Send message">
          <Send aria-hidden="true" />
          <span className="max-sm:sr-only">Send</span>
        </Button>
      </div>
      <p id="message-help" className={left < 0 ? "text-xs font-medium text-warning-muted" : "text-xs text-text-muted"}>
        {left < 0 ? `${-left} over the ${maxLength.toLocaleString("en-US")}-character limit` : left <= Math.min(100, Math.round(maxLength * 0.1)) ? `${left} characters left` : "Messages are text only."}
      </p>
      {status && (
        <p role="alert" data-slot="composer-status" className="text-xs font-medium text-warning-muted">
          {status}
        </p>
      )}
      {shareOpen && (
        <SharePanel
          recipientId={recipientId}
          onClose={() => setShareOpen(false)}
          onSent={(r) => {
            setShareOpen(false);
            onSent(r);
          }}
        />
      )}
    </div>
  );
}

function SharePanel({ recipientId, onClose, onSent }: { recipientId: string; onClose: () => void; onSent: (r: MessagingActionResult) => void }) {
  const [link, setLink] = useState("");
  const [choices, setChoices] = useState<ShareChoice[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    void listShareChoicesAction().then((c) => live && setChoices(c));
    return () => {
      live = false;
    };
  }, []);

  const share = useCallback(
    (args: { type?: ShareType; ref?: string; link?: string }) => {
      startTransition(async () => {
        const r = await shareObjectAction({ recipientId, ...args, idempotencyKey: crypto.randomUUID() });
        setStatus(r.ok ? null : r.message);
        if (r.ok) onSent(r);
      });
    },
    [recipientId, onSent],
  );

  return (
    <div data-slot="share-panel" className="space-y-3 rounded-lg border border-border-subtle p-3 text-sm">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-text-primary">Share</p>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) share({ link });
        }}
      >
        <label htmlFor="share-link" className="sr-only">
          A Brohda Game or Market link
        </label>
        <input
          id="share-link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Paste a Brohda Game or Market link"
          className="h-9 min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary"
        />
        <Button type="submit" variant="outline" disabled={pending || !link.trim()}>
          Share
        </Button>
      </form>
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Your Picks and Call BS</p>
        {choices === null ? (
          <p className="text-text-muted">Loading…</p>
        ) : choices.length === 0 ? (
          <p className="text-text-muted">Nothing to share yet.</p>
        ) : (
          <ul className="space-y-1">
            {choices.map((c) => (
              <li key={`${c.type}:${c.ref}`}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => share({ type: c.type, ref: c.ref })}
                  className="w-full rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  <span className="block text-[11px] font-semibold uppercase tracking-wide text-text-muted">{c.type === "PICK" ? "Pick" : "Call BS"}</span>
                  <span className="block font-medium text-text-primary">{c.title}</span>
                  {c.detail && <span className="block text-xs text-text-secondary">{c.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {status && (
        <p role="alert" className="text-xs font-medium text-warning-muted">
          {status}
        </p>
      )}
    </div>
  );
}
