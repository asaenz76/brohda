import type { Metadata } from "next";
import Link from "next/link";
import { PublicPageFrame } from "@/components/shell/PublicPageFrame";
import { publicAccountNav } from "@/components/shell/PublicAccountNav";
import { buttonVariants } from "@/components/ui/button";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { SPONSOR_TERMS_DOCUMENT } from "@/lib/sponsor/terms";
import { SPONSOR_LOGIN, SPONSOR_SIGNUP } from "@/lib/auth/account-routing";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Sponsorship — brohda.",
  description: "Sponsor a Game Post on brohda. — a clearly labeled place for your brand next to the conversation around a real sporting event.",
};

// Read per request: whether campaigns are open right now follows the sponsorship capability (never a hard-coded claim).
export const dynamic = "force-dynamic";

const STEPS = [
  "Create a Sponsor account.",
  "Brohda reviews and approves your Sponsor account.",
  "Choose an available Game.",
  "Submit your sponsorship and pay.",
  "Brohda reviews the campaign.",
  "Paid and approved campaigns run during their scheduled window.",
] as const;

const GET = [
  "A visible “Sponsored · Presented by” label on the Game Post",
  "Your brand name and logo",
  "An approved call-to-action link",
  "An optional sponsor-run promotion, with its official rules linked",
  "Aggregate performance reporting is planned but not available yet",
] as const;

const NOT_GET = [
  "Any control over Markets or Picks",
  "Any control over comments",
  "Any control over grading or results",
  "Access to individual brohda. Members or their data",
] as const;

// The public page for businesses: what a sponsored Game Post is and the way in. It is NOT the Sponsor dashboard, a store or a report; the dedicated
// Sponsor registration (/sponsor/signup) is the only call to action — never Member registration.
export default async function SponsorshipPage() {
  const open = await isSponsorshipEnabled().catch(() => false);
  return (
    <PublicPageFrame accountNav={await publicAccountNav()}>
      <article className="space-y-10">
        <header className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight text-text-primary">Sponsor the game conversation.</h1>
          <p className="text-base text-text-secondary">
            brohda. is where people talk about real sporting events, one Game Post at a time. A brand can sponsor an individual Game Post and sit, clearly labeled, right beside that
            conversation.
          </p>
          {!open && (
            <p role="status" data-slot="sponsorship-closed" className="rounded-lg border border-border-subtle p-3 text-sm text-text-secondary">
              New sponsored campaigns are not open right now. You can still apply for a Sponsor account; Brohda will review it, and you can start a sponsorship when campaigns open.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link href={SPONSOR_SIGNUP} className={cn(buttonVariants({ size: "lg" }))}>
              Become a Sponsor
            </Link>
            <Link href={SPONSOR_LOGIN} className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
              Sponsor log in
            </Link>
          </div>
        </header>

        <section aria-labelledby="how" className="space-y-3">
          <h2 id="how" className="text-xl font-semibold text-text-primary">
            How it works
          </h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-text-secondary">
            {STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="text-sm text-text-secondary">Every sponsorship needs both payment and Brohda&apos;s approval before it can run. Paying does not guarantee approval.</p>
        </section>

        <section aria-labelledby="get" className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <h2 id="get" className="text-xl font-semibold text-text-primary">
              What sponsors get
            </h2>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-secondary">
              {GET.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-text-primary">What sponsors do not get</h2>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-secondary">
              {NOT_GET.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="clear" className="space-y-2">
          <h2 id="clear" className="text-xl font-semibold text-text-primary">
            Always clearly labeled
          </h2>
          <p className="text-sm text-text-secondary">
            A sponsored Game Post is marked “Sponsored” and shows who it is presented by. Sponsorship never changes which Markets are offered, how Picks are made or graded, what
            Members say, or any result. Brohda keeps editorial and product control. If a sponsor runs a promotion, the sponsor — not Brohda — is responsible for its official rules and
            for delivering any prize.
          </p>
        </section>

        <section aria-label="Next steps" className="space-y-3 border-t border-border-subtle pt-6">
          <Link href={SPONSOR_SIGNUP} className={cn(buttonVariants({ size: "lg" }))}>
            Become a Sponsor
          </Link>
          <p className="text-sm text-text-muted">
            Read the{" "}
            <Link href={SPONSOR_TERMS_DOCUMENT.href} className="underline underline-offset-4">
              Sponsor Terms{SPONSOR_TERMS_DOCUMENT.status === "DRAFT" ? " (draft)" : ""}
            </Link>{" "}
            before you apply.
          </p>
        </section>
      </article>
    </PublicPageFrame>
  );
}
