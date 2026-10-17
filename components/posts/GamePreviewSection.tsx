import type { GamePreview } from "@/lib/game-previews/types";

/**
 * The editorial reason to open a Post: a short hook and a short factual story about this Game, read from what was saved ahead of time (nothing is researched or generated when a Member opens the Post). With no saved Preview
 * the block is simply absent and the Post is still the Game and its conversation — it never errors or shows a placeholder because editorial content is not ready.
 */
export function GamePreviewSection({ preview }: { preview: GamePreview | null }) {
  if (!preview) return null;
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
    </section>
  );
}
