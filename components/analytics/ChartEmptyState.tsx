// Every graph needs an intentional empty state — never a misleading zero
// or a blank chart. Callers pass a specific reason ("Enter more pools to
// unlock this graph.", "No settled pools in this range.", etc).
export function ChartEmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border-subtle px-4 text-center text-sm text-text-muted">
      {message}
    </div>
  );
}
