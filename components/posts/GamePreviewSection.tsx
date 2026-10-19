import { ExternalLink } from "lucide-react";
import type { GamePreview } from "@/lib/game-previews/types";

const formatDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/**
 * The editorial reason to open a Post: a short hook and a short factual story about this Game, read from what was saved ahead of time (nothing is researched or generated when a Member opens the Post). With no saved Preview the block is simply absent
 * and the Post is still the Game and its conversation — it never errors or shows a placeholder because editorial content is not ready.
 *
 * Every published Preview credits the reporting it rests on, in small secondary print under the text: "Source: ESPN · Oct. 18, 2026", linking to the publisher's own page (never a copy of it). One source, or a second only when the story materially depends on it —
 * never a bibliography. The data layer does not return a Preview that has nothing to credit.
 */
export function GamePreviewSection({ preview }: { preview: GamePreview | null }) {
  if (!preview || preview.sources.length === 0) return null;
  const [primary, ...also] = preview.sources;
  const link = "underline decoration-border-subtle underline-offset-2 hover:text-text-secondary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";
  const date = formatDate(primary.publishedAt);
  return (
    <section aria-labelledby="game-preview-heading" data-slot="game-preview" className="space-y-2">
      <h2 id="game-preview-heading" className="text-xs font-medium uppercase tracking-wide text-text-muted">
        Game Preview
      </h2>
      <p className="text-lg font-semibold leading-snug text-text-primary text-balance" data-slot="game-preview-hook">
        {preview.hook}
      </p>
      <p className="text-[15px] leading-relaxed text-text-secondary" data-slot="game-preview-body">
        {preview.body}
      </p>
      <p className="text-xs leading-snug text-text-muted" data-slot="game-preview-source">
        <span>Source: </span>
        <a href={primary.url} target="_blank" rel="noopener noreferrer" className={link} title={primary.title ?? undefined} aria-label={`Source: ${primary.name}${primary.title ? ` — ${primary.title}` : ""} (opens in a new tab)`}>
          {primary.name}
          <ExternalLink aria-hidden="true" className="ml-0.5 inline size-3 align-[-1px]" />
        </a>
        {date && <span> · {date}</span>}
        {also.map((s) => (
          <span key={s.url} data-slot="game-preview-also">
            {" · Also: "}
            <a href={s.url} target="_blank" rel="noopener noreferrer" className={link} title={s.title ?? undefined} aria-label={`Also: ${s.name}${s.title ? ` — ${s.title}` : ""} (opens in a new tab)`}>
              {s.name}
              <ExternalLink aria-hidden="true" className="ml-0.5 inline size-3 align-[-1px]" />
            </a>
          </span>
        ))}
      </p>
    </section>
  );
}
