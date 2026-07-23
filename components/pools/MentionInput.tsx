"use client";

import { useEffect, useRef, useState } from "react";
import { searchUsersForMentionAction, type MentionCandidate } from "@/lib/actions/mentions";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";

// Matches an in-progress "@handle" ending at the cursor — requires a
// word-boundary before the "@" (start of string or whitespace) so this
// never triggers mid-word or right after an email-like "@".
const ACTIVE_MENTION_REGEX = /(?:^|\s)@([a-z0-9_]{0,24})$/i;

export function MentionInput({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<MentionCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (query === null || query.length === 0) return;
    let cancelled = false;
    const timeout = setTimeout(() => {
      searchUsersForMentionAction(query).then((results) => {
        if (!cancelled) {
          setSuggestions(results);
          setActiveIndex(0);
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  // Derived, not stored: an empty/null query means "no active mention", so
  // the dropdown must disappear immediately rather than waiting on the
  // debounce above (which only ever fires for a non-empty query).
  const visibleSuggestions = query === null || query.length === 0 ? [] : suggestions;

  function activeMentionMatch(nextValue: string, cursor: number) {
    return nextValue.slice(0, cursor).match(ACTIVE_MENTION_REGEX);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = e.target.value;
    onChange(nextValue);
    const cursor = e.target.selectionStart ?? nextValue.length;
    const match = activeMentionMatch(nextValue, cursor);
    setQuery(match ? match[1].toLowerCase() : null);
  }

  function selectSuggestion(username: string) {
    const el = inputRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? value.length;
    const match = activeMentionMatch(value, cursor);
    if (!match) return;

    const mentionStart = cursor - match[0].length + (match[0].startsWith("@") ? 0 : 1);
    const before = value.slice(0, mentionStart);
    const after = value.slice(cursor);
    const nextValue = `${before}@${username} ${after}`;
    onChange(nextValue);
    setQuery(null);

    const newCursor = before.length + username.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (visibleSuggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % visibleSuggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + visibleSuggestions.length) % visibleSuggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      selectSuggestion(visibleSuggestions[activeIndex].username);
    } else if (e.key === "Escape") {
      // Close only the suggestion popup — stop the keypress from also
      // reaching CommentSheet's document-level Escape handler, which would
      // otherwise close the whole sheet.
      e.stopPropagation();
      setQuery(null);
    }
  }

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        maxLength={500}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={className}
      />
      {visibleSuggestions.length > 0 && (
        <ul className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-56 overflow-y-auto rounded-lg border border-border-subtle bg-surface-primary py-1 shadow-lg">
          {visibleSuggestions.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectSuggestion(s.username)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                  i === activeIndex ? "bg-surface-secondary" : "hover:bg-surface-secondary",
                )}
              >
                <Avatar displayName={s.displayName} avatarUrl={s.avatarUrl} size="sm" />
                <span className="font-medium text-text-primary">@{s.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
