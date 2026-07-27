import Link from "next/link";

export function LandingFooter() {
  return (
    <footer className="border-t border-border-subtle px-4 py-8 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-sm text-text-muted sm:flex-row">
        <span className="font-logo italic">brohda.</span>
        <div className="flex items-center gap-4">
          <Link href="/terms" className="hover:text-text-secondary">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-text-secondary">
            Privacy
          </Link>
        </div>
      </div>
    </footer>
  );
}
