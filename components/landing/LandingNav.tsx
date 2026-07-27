import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ThemeToggle";

// Deliberately just logo + how-it-works anchor + the two auth CTAs — no
// "Community"/"About" links, since those pages don't exist yet and a
// marketing nav shouldn't point at pages we haven't built.
export function LandingNav() {
  return (
    <header className="sticky top-0 z-10 border-b border-border-subtle bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <span className="font-logo text-xl font-extrabold italic text-text-primary">brohda.</span>
        <nav className="hidden items-center gap-6 text-sm font-medium text-text-secondary sm:flex">
          <a href="#how-it-works" className="hover:text-text-primary">
            How it works
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            Sign in
          </Link>
          <Link href="/register" className={cn(buttonVariants({ size: "sm" }))}>
            Join the beta
          </Link>
        </div>
      </div>
    </header>
  );
}
