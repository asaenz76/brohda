import Link from "next/link";
import { Users2, ShieldCheck, Trophy } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PhoneFrame } from "./PhoneFrame";

const BULLETS = [
  { icon: Users2, label: "Compete with people, not against the house" },
  { icon: ShieldCheck, label: "Real games" },
  { icon: Trophy, label: "No money, ever" },
];

export function LandingHero() {
  return (
    <section className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-2 lg:items-center lg:py-24">
      <div className="space-y-6">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-primary-subtle px-3 py-1 text-xs font-semibold text-accent-primary">
          <span className="size-1.5 rounded-full bg-accent-primary" aria-hidden="true" />
          Now open
        </span>
        <h1 className="text-balance text-4xl font-bold tracking-tight text-text-primary sm:text-5xl">
          Make the call. <span className="text-accent-primary">Challenge your friends.</span>
        </h1>
        <p className="max-w-md text-lg text-text-secondary">
          Predict NFL outcomes, join the conversation, and prove you know the game
          better than your friends.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/register" className={cn(buttonVariants({ size: "lg" }), "px-6")}>
            Sign up
          </Link>
          <a
            href="#how-it-works"
            className={cn(buttonVariants({ variant: "outline", size: "lg" }), "px-6")}
          >
            See how it works
          </a>
        </div>
        <ul className="flex flex-col gap-2 text-sm text-text-secondary sm:flex-row sm:flex-wrap sm:gap-x-5">
          {BULLETS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-1.5">
              <Icon className="size-4 text-accent-primary" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
        <p className="text-xs text-text-muted">
          <span className="font-medium text-text-secondary">Available now:</span> NFL
          {" · "}
          <span className="font-medium text-text-secondary">Coming soon:</span> NBA, NHL, and MLB
        </p>
      </div>

      <div className="hidden lg:block">
        <PhoneFrame>
          <div className="flex h-64 items-center justify-center text-sm text-text-muted">
            New games open soon.
          </div>
        </PhoneFrame>
      </div>
    </section>
  );
}
