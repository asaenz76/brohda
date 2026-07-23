export function ChartErrorState({ message = "Couldn't load this graph. Try again shortly." }: { message?: string }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-danger/40 px-4 text-center text-sm text-danger">
      {message}
    </div>
  );
}
