import Link from "next/link";
import { describeLockWindow, describePickDeadline, describeStakeLimits, formatFeePercent, type RulesPolicy } from "@/lib/rules/format";

// The one source of truth for how Brohda works, in plain language. Both the
// logged-out and the signed-in /rules render exactly this. Every statement
// below was checked against the live code: set_pick / call_bs /
// accept_call_bs / propose_money / accept_monetary_proposal /
// settle_monetary_position, the grading rules (lib/predictions) and the
// reputation functions. The mutable values (cutoff, fee, stake limits, the
// on/off switches) arrive as `policy` from the live settings; when one
// couldn't be read the copy goes generic rather than quoting a number.
//
// The optional money layer is described only when it is on for consumers
// (policy.monetaryEnabled === true — an unreadable setting counts as off).
// When it is off the page simply describes the free product: the Money
// section is absent, and no sentence anywhere mentions stakes, fees, holds,
// funding, Positions or the wallet. There's no "coming soon" or "disabled"
// placeholder — nothing marks where it would have been.
//
// The page that hosts this supplies the h1.

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-border-subtle pt-6 first:border-t-0 first:pt-0">
      <h2 id={id} className="text-lg font-semibold text-text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}

const body = "text-sm leading-relaxed text-text-secondary";
const list = "list-disc space-y-2 pl-5 text-sm leading-relaxed text-text-secondary marker:text-text-muted";

export function RulesContent({ policy }: { policy: RulesPolicy }) {
  const lock = describeLockWindow(policy.lockMinutesBeforeKickoff);
  const until = describePickDeadline(policy.lockMinutesBeforeKickoff);
  const fee = formatFeePercent(policy.feeBps);
  const limits = describeStakeLimits(policy.minStakeCents, policy.maxStakeCents);
  const money = policy.monetaryEnabled === true;

  return (
    <div className="space-y-6">
      <p className={body}>
        How Brohda works, in plain language. This page explains the product; the legal agreement is the{" "}
        <Link href="/terms" className="underline underline-offset-4 hover:text-text-primary">
          Terms
        </Link>
        , and how data is handled is in the{" "}
        <Link href="/privacy" className="underline underline-offset-4 hover:text-text-primary">
          Privacy policy
        </Link>
        .
      </p>

      <Section id="rules-basics" title="The basics">
        <p className={body}>
          Brohda is a social network around real sporting events. Brohda publishes the games; you take part with Picks, comments and Call BS
          {money ? " and, if you choose, with money" : ""}. Members never create the games themselves.
        </p>
      </Section>

      <Section id="rules-game-posts" title="Game Posts">
        <ul className={list}>
          <li>Every Game Post is created by Brohda. Members can&apos;t create, edit or remove one.</li>
          <li>A Game Post represents a real sporting event, and it can carry more than one Market — a question about the game, like who wins.</li>
          <li>Members don&apos;t publish games or Markets.</li>
          <li>Comments and everything else people do around a game belong to that game&apos;s Post.</li>
        </ul>
      </Section>

      <Section id="rules-picks" title="Picks">
        <ul className={list}>
          <li>A Pick is your opinion on a Market: one side of its question.</li>
          <li>{money ? "A Pick is free. Money is a separate, optional layer, and nothing about Picks needs it." : "A Pick is free."}</li>
          <li>You can make or change your Pick {until}.</li>
          <li>When that cutoff passes, your Pick locks: ordinary Pick changes stop, and your final Pick is the one on your record.</li>
        </ul>
      </Section>

      <Section id="rules-locking" title="When Picks lock">
        <p className={body}>
          Picks lock {lock}, or as soon as the game is no longer waiting to start. After that you can&apos;t make a Pick or change one.
        </p>
        <p className={body}>
          {money ? "Sending or accepting a Call BS, or a money offer, closes at the same time." : "Sending or accepting a Call BS closes at the same time."}
        </p>
        <p className={body}>
          Your Pick stays editable until then unless you enter something that needs it to hold still: {money ? "accepting a Call BS, or a money Position being accepted," : "accepting a Call BS"}{" "}
          locks the Picks involved immediately.
        </p>
      </Section>

      <Section id="rules-call-bs" title="Call BS">
        {policy.callBsEnabled === false && <p className={body}>Call BS is switched off right now. This is how it works when it&apos;s on.</p>}
        <ul className={list}>
          <li>
            {money
              ? "Call BS is a free, head-to-head challenge between two people who picked opposite sides of the same Market. It involves no money."
              : "Call BS is a head-to-head challenge between two people who picked opposite sides of the same Market."}
          </li>
          <li>Sending a Call BS doesn&apos;t lock either Pick. If either of you changes your Pick before it&apos;s accepted, it can no longer be accepted.</li>
          <li>You can have several Call BS waiting at once, and the other person decides whether to accept. It has to be accepted before the cutoff.</li>
          <li>Each person can be in only one accepted Call BS per Market. Accepting locks both Picks right away, and every other waiting Call BS involving either of you on that Market becomes unavailable.</li>
          <li>A Call BS is decided by the Market&apos;s result: whoever&apos;s Pick was right wins.</li>
        </ul>
        <h3 className="pt-1 text-sm font-semibold text-text-primary">Your Call BS record</h3>
        <ul className={list}>
          <li>Only accepted Call BS that have been decided count, each as a win or a loss. They show on your Profile as, for example, Call BS: 8–4.</li>
          <li>Waiting, declined, expired and unavailable Call BS don&apos;t count.</li>
          <li>A voided Call BS is neither a win nor a loss, so it doesn&apos;t count either.</li>
          <li>On someone else&apos;s Profile, and next to their Pick on a game, you&apos;ll see your own record against them once you have results with them.</li>
        </ul>
      </Section>

      <Section id="rules-record" title="Your prediction record">
        <ul className={list}>
          <li>
            Your prediction accuracy is the share of your decided Picks that were right: correct ÷ (correct + incorrect). Voided Picks are left out of it.
          </li>
          <li>&ldquo;Predicted&rdquo; is the number of your Picks that have been graded, voided ones included. A Pick still waiting for its result isn&apos;t counted yet.</li>
          <li>It shows as, for example, 67% prediction accuracy · 42 predicted, and there&apos;s no percentage until you have at least one decided Pick.</li>
          <li>{money ? "Call BS and money never change it. Your prediction record comes only from your Picks." : "Call BS never changes it. Your prediction record comes only from your Picks."}</li>
        </ul>
      </Section>

      {money && (
        <Section id="rules-money" title="Money">
          <p className={body}>
            Money is optional, and it&apos;s separate from Picks and from Call BS. You can take part in everything else without it.
          </p>
          <ul className={list}>
            <li>You can offer money to someone who picked the opposite side of the same Market, before the cutoff.</li>
            <li>{limits ? `Each offer must be ${limits}.` : "Each offer has a minimum and a maximum amount, shown when you make it."}</li>
            <li>You need enough available balance. Sending an offer holds your amount out of your available balance; holding it isn&apos;t the same as the other person accepting.</li>
            <li>The other person has to accept it themselves. Accepting needs their own matching available balance, which is then held too, and it locks both Picks immediately.</li>
            <li>Between the same two Picks there&apos;s at most one active money Position per Market. You can still have offers and Positions with different people on the same Market, as long as your balance covers each one.</li>
            <li>If an offer is declined, withdrawn, or runs out at the cutoff, the amount held for it is released.</li>
            <li>It&apos;s separate from Call BS: a Call BS and a money Position between the same two people don&apos;t count as each other, and a Position never adds a Call BS result.</li>
          </ul>
          <h3 className="pt-1 text-sm font-semibold text-text-primary">The fee</h3>
          <p className={body}>
            When a Position settles with a winner, Brohda takes a fee out of the losing amount and credits the rest to the winner; the winner&apos;s own amount is
            simply released. {fee ? `The fee is currently ${fee}.` : "The fee rate is shown before you confirm an offer."} The rate is fixed on a Position at the moment
            it&apos;s accepted. Before you confirm anything, Brohda shows the amount, the fee and what will be held.
          </p>
        </Section>
      )}

      <Section id="rules-results" title="Results and grading">
        <ul className={list}>
          <li>Brohda grades Markets from official sports results once a game is final, and grades the Picks on them automatically. Once a Pick is graded it doesn&apos;t change.</li>
          <li>{money ? "Call BS and money results follow from the Market\u2019s result." : "Call BS results follow from the Market\u2019s result."}</li>
          <li>Comments, community sentiment and what most people picked don&apos;t affect grading.</li>
          <li>Results come from sports data feeds. Brohda works from them as they are and can&apos;t promise that data is perfect.</li>
        </ul>
      </Section>

      <Section id="rules-void" title="When a game can&apos;t be decided">
        <ul className={list}>
          <li>If a game is cancelled, or a line lands exactly on the result (a push), the Market is voided. If a game is postponed or suspended, Picks wait; nothing is guessed.</li>
          <li>A voided Pick counts as predicted but as neither correct nor incorrect.</li>
          <li>A voided Call BS is neither a win nor a loss for either person.</li>
          {money && <li>A voided money Position releases what was held on both sides. No fee is taken and nothing moves.</li>}
        </ul>
      </Section>

      <Section id="rules-conduct" title="Comments and conduct">
        <p className={body}>
          Disagreement is the point, and the conversation belongs to the Game Post. You can delete your own comments, and moderators can remove comments. What
          isn&apos;t allowed on Brohda is covered in the{" "}
          <Link href="/terms" className="underline underline-offset-4 hover:text-text-primary">
            Terms
          </Link>
          .
        </p>
      </Section>

      <Section id="rules-source" title="Where these rules come from">
        <p className={body}>
          This page describes how Brohda works today. {money ? "The cutoff, the fee and the limits quoted here are" : "The cutoff quoted here is"} read from Brohda&apos;s live settings, so{" "}
          {money ? "they stay" : "it stays"} current. It isn&apos;t the legal agreement — that&apos;s the{" "}
          <Link href="/terms" className="underline underline-offset-4 hover:text-text-primary">
            Terms
          </Link>
          .
        </p>
      </Section>
    </div>
  );
}
