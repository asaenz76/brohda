import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "How brohda. works — brohda.",
  description: "How Brohda works and how to play: pick a side, talk shit, call BS, and see who was right.",
  robots: { index: false, follow: false },
};

// A public explainer that lives beside the Terms and the Privacy policy
// (app/terms, app/privacy) and is linked from the same footer, signed in or
// out. It describes what the product does today in plain language; it makes
// no numbers up — anything that is configurable (when picks lock, limits,
// fees) is described rather than quoted, and the app shows the live values
// at the moment they matter.
export default function HowItWorksPage() {
  return (
    <LegalPage
      title="How Brohda works"
      closing={
        <p>
          The details that matter for your account are in the{" "}
          <Link href="/terms" className="underline underline-offset-4">
            Terms
          </Link>{" "}
          and the{" "}
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy policy
          </Link>
          .
        </p>
      }
    >
      <section>
        <p>
          Brohda is a social network for people who think they know sports. Sports opinions should have a record, so here
          you pick a side, talk it out, call BS on people who disagree, and see who was right.
        </p>
      </section>

      <section>
        <h2>The games</h2>
        <p>
          Every game on Brohda is published by Brohda. You can&apos;t create, edit or remove a game, and no member is ever
          the author of one — what you add is your own opinion: your pick and your comments. Upcoming games are on Home.
          Use the Sports, Leagues and Teams tabs to browse, and follow the teams and leagues you care about to see their
          games first.
        </p>
      </section>

      <section>
        <h2>How to play</h2>
        <ol>
          <li>
            <strong>Pick a side.</strong> Every game comes with a question, like &quot;Will the Bills win?&quot; Choose the
            answer you believe. It&apos;s free, and you can see how everyone else is leaning.
          </li>
          <li>
            <strong>Change your mind, until it locks.</strong> You can switch your pick until picks lock, shortly before the
            game starts. After that it&apos;s final. Accepting a Call BS (below) also locks both picks.
          </li>
          <li>
            <strong>Talk shit.</strong> Open any game to join the conversation. Comment, reply, and see who&apos;s
            saying what, with each person&apos;s record next to their name.
          </li>
          <li>
            <strong>Call BS.</strong> When someone picked the other side of a game, you can call BS on their pick. They can
            accept or decline. If they accept, both picks lock, and when the game is decided whoever was right gets the win
            on their head-to-head record. It&apos;s a free, friendly challenge between two people.
          </li>
          <li>
            <strong>See who was right.</strong> When the game ends, every pick is graded automatically from the final result.
            You&apos;ll get a notification, and your record updates.
          </li>
        </ol>
      </section>

      <section>
        <h2>Your record</h2>
        <p>
          Your prediction accuracy is the share of your decided picks that were right, next to the number of games you&apos;ve
          predicted. It starts blank until you have a graded pick — Brohda never shows a made-up percentage. There are no
          points, levels or ranks. Your Call BS wins and losses are counted separately from your accuracy.
        </p>
      </section>

      <section>
        <h2>When a game doesn&apos;t finish</h2>
        <p>
          If a game is cancelled or can&apos;t be decided, picks on it are voided. A voided pick still counts as a game you
          predicted, but it never counts for or against your accuracy.
        </p>
      </section>

      <section>
        <h2>Money</h2>
        <p>
          Picks, comments and Call BS are always free. Separately, members may be offered an optional way to put money behind
          a disagreement. It is never required and never part of your prediction record, and before you confirm anything
          Brohda shows you the amount, any platform fee, and the funds that would be held. If you&apos;d rather keep it
          purely about the picks, ignore it.
        </p>
      </section>
    </LegalPage>
  );
}
