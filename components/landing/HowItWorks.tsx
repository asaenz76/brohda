import { ClipboardCheck, Users2, Trophy } from "lucide-react";

const STEPS = [
  {
    icon: ClipboardCheck,
    title: "Pick",
    description: "Choose an outcome before the pool locks.",
  },
  {
    icon: Users2,
    title: "Compete",
    description: "Join friends and community members making their own predictions.",
  },
  {
    icon: Trophy,
    title: "Prove it",
    description: "Track your record, build streaks, and climb the leaderboard.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h2 className="text-center text-2xl font-bold text-text-primary sm:text-3xl">How it works</h2>
      <p className="mt-2 text-center text-text-secondary">Three simple steps to join the action.</p>
      <div className="mt-10 grid gap-8 sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, description }, i) => (
          <div key={title} className="space-y-3 text-center sm:text-left">
            <div className="flex items-center justify-center gap-2.5 sm:justify-start">
              <span className="flex size-9 items-center justify-center rounded-full bg-accent-primary-subtle text-sm font-semibold text-accent-primary">
                {i + 1}
              </span>
              <Icon className="size-5 text-accent-primary" aria-hidden="true" />
            </div>
            <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
            <p className="text-sm text-text-secondary">{description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
