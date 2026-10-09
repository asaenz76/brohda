import { PublicPageFrame } from "@/components/shell/PublicPageFrame";

// The body of a standalone legal document (Terms, Privacy, Sponsor Terms). The page chrome — the Brohda header (logo, Log in / Create account, or the
// signed-in equivalent) and the shared footer — is the SAME PublicPageFrame Rules uses, so the public pages cannot drift apart. The old "← Back to
// brohda." link is gone on purpose: the header's logo is the way home, and a link that always went to "/" (not to where the reader came from) was the
// surprising kind of Back.
export function LegalPage({
  title,
  effectiveDate,
  accountNav,
  banner,
  children,
}: {
  title: string;
  effectiveDate: string;
  /** What the header offers a signed-in visitor (see publicAccountNav); omitted for a signed-out visitor. */
  accountNav?: React.ReactNode;
  /** Shown above the title — marks a document that is still a DRAFT awaiting owner/counsel approval. */
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <PublicPageFrame accountNav={accountNav}>
      {banner}
      <h1 className="font-heading text-2xl font-semibold text-text-primary sm:text-3xl">{title}</h1>
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
    </PublicPageFrame>
  );
}
