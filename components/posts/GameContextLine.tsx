// Brohda 2.1 M3 — the one deterministic Game Context line (lib/game-context), as supporting copy under a Game's date. Plain text, no controls: it never competes with the Pick buttons.
export function GameContextLine({ text }: { text: string }) {
  return (
    <p data-slot="game-context" className="text-sm text-text-secondary">
      {text}
    </p>
  );
}
