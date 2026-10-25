/**
 * The approved story of a Game, on its canonical Post: a short hook and a compact factual body, nothing else. No sources, no disclaimers, no call to action — the Pick buttons are the call to action.
 * It reads what an Admin approved; nothing is researched or generated when a Member opens the Post. With no approved story the block is simply absent and the Post is the Game and its conversation, exactly as before.
 */
export function GameStorySection({ story }: { story: { hook: string; body: string } | null }) {
  if (!story) return null;
  return (
    <section aria-labelledby="game-story-heading" data-slot="game-story" className="space-y-2">
      <h2 id="game-story-heading" className="sr-only">
        The story
      </h2>
      <p className="text-lg font-semibold leading-snug text-text-primary text-balance" data-slot="game-story-hook">
        {story.hook}
      </p>
      <p className="text-[15px] leading-relaxed text-text-secondary" data-slot="game-story-body">
        {story.body}
      </p>
    </section>
  );
}
