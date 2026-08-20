import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FinalCta() {
  return (
    <section className="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6">
      <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">Think you know the game?</h2>
      <p className="mt-3 text-text-secondary">
        Join brohda and start building your prediction record.
      </p>
      <div className="mt-6 flex flex-col items-center gap-3">
        <Link href="/register" className={cn(buttonVariants({ size: "lg" }), "px-8")}>
          Create your profile
        </Link>
        <p className="text-sm text-text-secondary">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent-primary underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </div>
    </section>
  );
}
