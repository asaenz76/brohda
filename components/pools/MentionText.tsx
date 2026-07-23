import Link from "next/link";
import { MENTION_REGEX } from "@/lib/mentions";

// Linkifies @handle tokens optimistically, the same way Instagram/Twitter
// do — no lookup against real usernames at render time. A mention of a
// handle that doesn't exist just 404s like any other stale link, which is
// an acceptable tradeoff for not adding a query to every comment render.
export function MentionText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(MENTION_REGEX);

  return (
    <p className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Link
            key={i}
            href={`/profile/${part.toLowerCase()}`}
            className="font-medium text-accent-primary hover:underline"
          >
            @{part}
          </Link>
        ) : (
          part
        ),
      )}
    </p>
  );
}
