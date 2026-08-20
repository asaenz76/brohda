import Link from "next/link";

// Shared chrome for standalone legal documents (Terms, Privacy) — these are
// public routes reachable without auth (outside the (app)/(auth)/(admin)
// route groups), so they get their own minimal header instead of AppShell's
// nav or the auth screens' centered-card layout.
export function LegalPage({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:py-16">
      <Link
        href="/"
        className="text-sm text-text-secondary underline underline-offset-4 hover:text-text-primary"
      >
        ← Back to brohda.
      </Link>
      <h1 className="mt-6 font-heading text-2xl font-semibold text-text-primary sm:text-3xl">
        {title}
      </h1>
      <p className="mt-1 text-sm text-text-muted">Effective {effectiveDate}</p>
      <div className="mt-8 space-y-8 text-sm leading-relaxed text-text-secondary [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-text-primary [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_p+p]:mt-3 [&_strong]:font-semibold [&_strong]:text-text-primary [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
        {children}
      </div>
      <p className="mt-10 border-t border-border-subtle pt-6 text-sm text-text-muted">
        Questions about these terms?{" "}
        <a href="mailto:support@brohda.com" className="underline underline-offset-4">
          support@brohda.com
        </a>
      </p>
    </div>
  );
}
