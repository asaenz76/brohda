// bg/border use --inverted-surface (theme-invariant, see globals.css) —
// a phone's bezel is black regardless of whether the surrounding page is
// in light or dark mode, unlike bg-text-primary which would flip to a
// near-white bezel in dark mode.
//
// Fixed height (not max-height): every showcase panel needs to be the
// same size regardless of how much content it holds (a 3-item leaderboard
// vs. a single chart), so short content just leaves empty space at the
// bottom of its screen rather than shrinking the whole phone.
export function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mx-auto w-full max-w-[300px] rounded-[2.5rem] border-[6px] border-inverted-surface bg-inverted-surface p-2 shadow-2xl">
      <div className="absolute left-1/2 top-2 h-5 w-24 -translate-x-1/2 rounded-full bg-inverted-surface" aria-hidden="true" />
      <div className="h-[560px] overflow-hidden rounded-[2rem] bg-background">
        <div className="h-[560px] overflow-y-auto p-3 pt-7">{children}</div>
      </div>
    </div>
  );
}
