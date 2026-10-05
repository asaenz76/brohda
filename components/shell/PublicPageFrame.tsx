import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { cn } from "@/lib/utils";

// The logged-out frame for public reading pages that aren't the front door
// itself (Rules): the Brohda wordmark and the two ways in on top, a narrow
// readable column, and the same footer every page ends with. A signed-in
// visitor to the same URL gets the app shell instead — see AuthenticatedPage.
export function PublicPageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-background">
      <header className="border-b border-border-subtle">
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-4 py-2.5">
          <Link href="/" className="font-logo text-lg font-extrabold italic text-text-primary">
            brohda.
          </Link>
          <nav aria-label="Account" className="flex items-center gap-2">
            <Link href="/login" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Log in
            </Link>
            <Link href="/register" className={cn(buttonVariants({ size: "sm" }))}>
              Create account
            </Link>
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
