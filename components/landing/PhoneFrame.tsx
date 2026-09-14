// Bold border + hard offset shadow, same graphic language as every other
// card/button on the site (Button/Card primitives) — a white-bezel device
// frame with a text-primary outline, not the old solid-black bezel that
// only worked because the section around it was hardcoded dark too. Now
// that the whole page is a single light theme, the phone reads as "a card
// shaped like a phone" rather than an inverted, theme-invariant object.
//
// Fixed height (not max-height): every showcase panel needs to be the
// same size regardless of how much content it holds (a 3-item leaderboard
// vs. a single chart), so short content just leaves empty space at the
// bottom of its screen rather than shrinking the whole phone.
export function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mx-auto w-full max-w-[300px] rounded-[2.5rem] border-[6px] border-text-primary bg-surface-primary p-2 shadow-[6px_6px_0_0_var(--text-primary)]">
      <div className="absolute left-1/2 top-2 h-5 w-24 -translate-x-1/2 rounded-full bg-text-primary" aria-hidden="true" />
      <div className="h-[560px] overflow-hidden rounded-[2rem] bg-background">
        <div className="h-[560px] overflow-y-auto p-3 pt-7">{children}</div>
      </div>
    </div>
  );
}
