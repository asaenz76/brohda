// X.5.5: always visible, never hidden in a tooltip, plain language.
export function RulePill({ label }: { label: string }) {
  return (
    <span className="inline-block w-fit rounded-full bg-surface-secondary px-3 py-1 text-xs font-medium text-text-secondary">
      {label}
    </span>
  );
}
