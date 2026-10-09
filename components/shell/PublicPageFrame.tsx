import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { cn } from "@/lib/utils";

// THE public reading frame — Rules, Terms, Privacy, Sponsorship, Sponsor Terms all use it, so they cannot drift apart: the Brohda wordmark and the
// two ways in on top, a narrow readable column, and the same footer every page ends with. A signed-in MEMBER visiting Rules gets the app shell
// instead (see AuthenticatedPage). Anyone else who is signed in (a Member on Terms/Privacy, a Sponsor anywhere) still gets this frame, but with
// `accountNav` in place of "Log in / Create account", which would make no sense to a signed-in person (see PublicAccountNav).
export function PublicPageFrame({ children, accountNav }: { children: React.ReactNode; accountNav?: React.ReactNode }) {
  return (
    <div className="min-h-full bg-background">
      <header className="border-b border-border-subtle">
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-4 py-2.5">
          <Link href="/" className="font-logo text-lg font-extrabold italic text-text-primary">
            brohda.
          </Link>
          <nav aria-label="Account" className="flex items-center gap-2">
            {accountNav ?? (
              <>
                <Link href="/login" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                  Log in
                </Link>
                <Link href="/register" className={cn(buttonVariants({ size: "sm" }))}>
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-[720px] px-4 py-8">
        {children}
      </main>
      <div className="mx-auto w-full max-w-[720px] px-4 pb-10">
        <SiteFooter />
      </div>
    </div>
  );
}
