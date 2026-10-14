"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Avatar } from "@/components/Avatar";
import { LocalDateTime } from "@/components/LocalDateTime";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Composer } from "@/components/messaging/Composer";
import { SharedObjectCard } from "@/components/messaging/SharedObjectCard";
import { markConversationReadAction, reportAction, respondToRequestAction, setBlockAction, setMuteAction, unsendMessageAction } from "@/lib/actions/messaging";
import type { MessageWithShare } from "@/lib/messaging/views";
import type { Counterpart } from "@/lib/messaging/queries";

const REASONS: Array<[string, string]> = [
  ["SPAM", "Spam"],
  ["HARASSMENT", "Harassment"],
  ["THREAT", "A threat"],
  ["HATE", "Hateful content"],
  ["SEXUAL", "Sexual content"],
  ["SCAM", "A scam"],
  ["OTHER", "Something else"],
];

interface Props {
  conversationId: string;
  counterpart: Counterpart;
  status: "PENDING" | "ACTIVE" | "DECLINED";
  iAmRequester: boolean;
  incomingRequest: boolean;
  initialMuted: boolean;
  initialBlockedByMe: boolean;
  initialMessages: MessageWithShare[];
  serverTime: string;
  maxLength: number;
  unsendWindowSeconds: number;
  pollIntervalSeconds: number;
}

export function ConversationScreen(props: Props) {
  const { conversationId, counterpart, status, iAmRequester, incomingRequest, maxLength, unsendWindowSeconds, pollIntervalSeconds } = props;
  const router = useRouter();
  const [messages, setMessages] = useState<MessageWithShare[]>(props.initialMessages);
  const [muted, setMuted] = useState(props.initialMuted);
  const [blocked, setBlocked] = useState(props.initialBlockedByMe);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [report, setReport] = useState<{ messageId: string | null } | null>(null);
  const [pending, startTransition] = useTransition();
  const lastSeq = useRef(Math.max(0, ...props.initialMessages.map((m) => m.seq)));
  const since = useRef(props.serverTime);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const merge = useCallback((incoming: MessageWithShare[]) => {
    if (incoming.length === 0) return;
    setMessages((current) => {
      const byId = new Map(current.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.seq - b.seq);
    });
    lastSeq.current = Math.max(lastSeq.current, ...incoming.map((m) => m.seq));
  }, []);

  const idle = useRef(0);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages/${conversationId}?after=${lastSeq.current}&since=${encodeURIComponent(since.current)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageWithShare[]; serverTime: string };
      since.current = data.serverTime;
      idle.current = data.messages.length > 0 ? 0 : idle.current + 1;
      merge(data.messages);
    } catch {
      // A failed poll is simply tried again on the next tick; nothing is claimed about the state in between.
    }
  }, [conversationId, merge]);

  // Targeted polling: ONE small cursor query per tick, ONLY while this tab is visible. An idle open tab slows down (up to 6x the configured interval) and snaps back as soon as there is news, the tab
  // becomes visible again, or the Member sends something.
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (document.visibilityState === "visible") await poll();
        schedule();
      }, pollIntervalSeconds * 1000 * (1 + Math.min(Math.floor(idle.current / 3), 5)));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        idle.current = 0;
        void poll();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll, pollIntervalSeconds]);

  // The read cursor moves once per change in the newest message, never per message.
  const newestSeq = messages.length ? messages[messages.length - 1].seq : 0;
  useEffect(() => {
    if (newestSeq > 0 && status === "ACTIVE") void markConversationReadAction(conversationId, newestSeq);
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conversationId, newestSeq, status]);

  // Keeps "Unsend" honest as the window passes without a reload.
  useEffect(() => {
    if (unsendWindowSeconds <= 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [unsendWindowSeconds]);

  const canWrite = !blocked && !counterpart.unavailable && !incomingRequest && counterpart.id !== null && (status === "ACTIVE" || iAmRequester);
  const name = counterpart.displayName;

  function act(run: () => Promise<{ ok: boolean; message: string }>, after?: () => void) {
    startTransition(async () => {
      const r = await run();
      setNotice(r.message);
      if (r.ok) after?.();
    });
  }

  const unsendable = useMemo(() => (m: MessageWithShare) => m.fromMe && !m.removed && unsendWindowSeconds > 0 && now - Date.parse(m.createdAt) <= unsendWindowSeconds * 1000, [now, unsendWindowSeconds]);

  return (
    <div className="space-y-3" data-slot="conversation" data-status={status}>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle p-3">
        <Avatar displayName={name} avatarUrl={counterpart.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-text-primary" data-slot="counterpart-name">
            {counterpart.username ? (
              <Link href={`/profile/${counterpart.username}`} className="hover:underline">
                {name}
              </Link>
            ) : (
              name
            )}
          </p>
          {counterpart.unavailable && <p className="text-xs text-text-muted">This Member is unavailable.</p>}
          {blocked && <p className="text-xs text-text-muted">You&apos;ve blocked this Member.</p>}
          {muted && !blocked && <p className="text-xs text-text-muted">Muted</p>}
        </div>
        {counterpart.id && !counterpart.unavailable && (
          <div className="flex w-full flex-wrap gap-1.5 sm:w-auto" role="group" aria-label="Conversation actions">
            {status === "ACTIVE" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => act(() => setMuteAction(conversationId, !muted), () => setMuted((v) => !v))}
              >
                {muted ? "Unmute" : "Mute"}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => (blocked ? act(() => setBlockAction(counterpart.id!, false), () => setBlocked(false)) : setConfirmBlock(true))}>
              {blocked ? "Unblock" : "Block"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setReport({ messageId: null })}>
              Report
            </Button>
          </div>
        )}
      </div>

      {confirmBlock && counterpart.id && (
        <div role="alertdialog" aria-label={`Block ${name}`} data-slot="block-confirm" className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
          <p className="text-text-primary">Block {name}? They won&apos;t be able to message you. Your messages stay as they are.</p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => act(() => setBlockAction(counterpart.id!, true), () => { setBlocked(true); setConfirmBlock(false); })}>
              Block
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmBlock(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {incomingRequest && (
        <div data-slot="request-banner" className="space-y-2 rounded-lg bg-surface-secondary p-3 text-sm">
          <p className="font-semibold text-text-primary">{name} wants to message you.</p>
          <p className="text-text-secondary">You can&apos;t reply until you accept. They won&apos;t be told if you decline.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => act(() => respondToRequestAction(conversationId, "ACCEPT"), () => router.refresh())}>
              Accept
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => act(() => respondToRequestAction(conversationId, "DECLINE"), () => router.push("/messages?tab=requests"))}>
              Decline
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirmBlock(true)}>
              Block
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setReport({ messageId: null })}>
              Report
            </Button>
          </div>
        </div>
      )}

      {iAmRequester && status !== "ACTIVE" && !blocked && (
        <p data-slot="request-sent" className="rounded-lg bg-surface-secondary p-3 text-sm text-text-secondary">
          Request sent. You can only send a few messages until {name} accepts.
        </p>
      )}

      {notice && (
        <p role="status" data-slot="conversation-notice" className="text-xs font-medium text-text-primary">
          {notice}
        </p>
      )}

      {report && counterpart.id && (
        <ReportPanel
          conversationId={conversationId}
          messageId={report.messageId}
          onDone={(message) => {
            setReport(null);
            setNotice(message);
          }}
          onCancel={() => setReport(null)}
        />
      )}

      <ol aria-label={`Conversation with ${name}`} aria-live="polite" className="space-y-2" data-slot="thread">
        {messages.length === 0 && <li className="text-sm text-text-muted">No messages yet.</li>}
        {messages.map((m) => (
          <li key={m.id} data-slot="message" data-from={m.fromMe ? "me" : "them"} data-removed={m.removed ?? undefined} className={m.fromMe ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[85%] space-y-1 ${m.fromMe ? "items-end text-right" : "items-start text-left"}`}>
              {m.removed ? (
                <p data-slot="tombstone" className="rounded-2xl border border-dashed border-border-subtle px-3 py-1.5 text-sm italic text-text-muted">
                  {m.removed === "MODERATED" ? "This message was removed." : m.fromMe ? "You deleted a message." : `${name} deleted a message.`}
                </p>
              ) : m.kind === "SHARE" && m.share ? (
                <div className="text-left">
                  <SharedObjectCard view={m.share} />
                </div>
              ) : (
                <p className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-left text-sm ${m.fromMe ? "bg-accent-primary-subtle text-text-primary" : "bg-surface-secondary text-text-primary"}`}>{m.body}</p>
              )}
              <p className="flex items-center gap-2 text-[11px] text-text-muted" style={{ justifyContent: m.fromMe ? "flex-end" : "flex-start" }}>
                <LocalDateTime iso={m.createdAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                {unsendable(m) && (
                  <button type="button" disabled={pending} onClick={() => act(() => unsendMessageAction(m.id), () => void poll())} className="rounded px-1 underline outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring/50">
                    Unsend
                  </button>
                )}
                {!m.fromMe && !m.removed && counterpart.id && (
                  <button type="button" onClick={() => setReport({ messageId: m.id })} aria-label="Report this message" className="rounded px-1 underline outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring/50">
                    Report
                  </button>
                )}
              </p>
            </div>
          </li>
        ))}
        <div ref={endRef} />
      </ol>

      {canWrite && counterpart.id && (
        <Composer
          recipientId={counterpart.id}
          maxLength={maxLength}
          onSent={() => {
            idle.current = 0;
            void poll();
          }}
        />
      )}
      {!canWrite && !incomingRequest && (counterpart.unavailable || blocked) && (
        <p className="text-sm text-text-muted" data-slot="read-only">
          {blocked ? "Unblock this Member to message them." : "You can read this conversation, but not reply."}
        </p>
      )}
    </div>
  );
}

function ReportPanel({ conversationId, messageId, onDone, onCancel }: { conversationId: string; messageId: string | null; onDone: (message: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("SPAM");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      data-slot="report-panel"
      className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await reportAction({ conversationId, messageId, reason, note });
          if (r.ok || r.outcome === "already_reported") onDone(r.message);
          else setError(r.message);
        });
      }}
    >
      <p className="font-semibold text-text-primary">{messageId ? "Report this message" : "Report this conversation"}</p>
      <p className="text-text-secondary">Brohda reviews reports. They are not shared with the other Member.</p>
      <label className="block space-y-1 text-xs font-medium text-text-secondary">
        Reason
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary">
          {REASONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-xs font-medium text-text-secondary">
        Anything else we should know (optional)
        <Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} rows={2} />
      </label>
      {error && (
        <p role="alert" className="text-xs font-medium text-warning-muted">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Send report
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
