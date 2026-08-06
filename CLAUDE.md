# Product Constitution & Founder Checklist

brohda. is a private, invite-only sports pool platform for small friend
groups — equal-stakes, no odds, no sportsbook, reward is reputation, never
variable payout. This document is durable, standing law: every future
feature request, design decision, or code change in this repo runs against
it, not just the launch work that produced it (Founder Implementation Plan
Part 14 & 15). It is not a one-time report — treat it the same as any other
project instruction in this file.

## The Forever Principles

*The Forever Principles, expanded into permanent doctrine. Every future
feature request is measured against every line below.*

1. **Every PollPool has one entry fee, and money never buys a bigger
   victory.** Equal stakes are what make a correct call mean the same thing
   for everyone in the room. The moment stakes become unequal, "who knows
   the game best" stops being an honest question.
2. **One great prediction is worth more than ten mediocre ones.** Depth of
   feeling beats breadth of options, always. A product that offers fewer,
   better-considered choices will out-engage a product that offers more
   choices every time, because choice itself is a cost, not a feature.
3. **The feed always comes first.** Nothing — no settings screen, no
   dashboard, no wallet form — competes with the feed for the first five
   seconds of a session. If a new screen wants that position, the answer is
   no by default.
4. **People are more important than statistics.** A name and a face beat a
   percentage and a chart on every screen, every time. Identity exists
   specifically to keep this true even as the product's data gets richer —
   the data should always resolve into a person, never stand alone as a
   number.
5. **Emotion beats information.** When a screen must choose between showing
   more data or making someone feel something, it chooses the feeling. This
   is not anti-intellectual — it's a recognition that brohda.'s entire value
   proposition is emotional (pride, belonging, being right) and information
   is only useful in service of that.
6. **Every screen earns its place.** If a screen can't be explained by the
   one-sentence identity, it doesn't get a spot in primary navigation — it
   gets merged, demoted, or cut.
7. **Every feature earns its complexity.** A new setting, pool type, or
   status must justify itself against the emotional value it adds, not the
   completeness it provides. Completeness is not a goal of this product;
   memorability is.
8. **Every interaction should create a story worth telling someone else.**
   The test for any new idea: would someone screenshot this, or say it out
   loud to a friend? If the honest answer is no, the idea needs to be
   reworked until it is.
9. **The reward is always reputation, never variable payout.** brohda.'s
   loop runs on pride and being provably right, and it will never run on the
   mechanics of a slot machine. This line does not move, regardless of what
   growth metric it might improve.
10. **Simple products spread.** Every change that makes brohda. easier to
    explain in one sentence is worth more than any feature that makes it
    harder — this is true even when the feature is good, because
    distribution compounds and features don't.
11. **Identity is earned, never claimed.** No title, badge, or reputation
    marker is ever user-selected or purchasable. The moment a status can be
    gamed, it stops meaning anything, and every downstream benefit of the
    Identity System collapses with it.
12. **Reputation is current, not permanent.** Nothing in brohda. should
    reward someone forever for something they did once. Everything that
    confers status should be re-earnable, and losable, on an ongoing basis —
    this is what keeps checking in on your own standing, and everyone
    else's, worth doing.
13. **The product should always know what it doesn't need to say twice, and
    what it must never say in jargon.** Every player-facing sentence is
    measured against whether a stranger would understand it instantly.
    Backend concepts (statuses, versions, internal reasons) never reach a
    player-facing screen in their raw form.
14. **Silence is never acceptable where trust is at stake.** Anywhere a user
    could reasonably wonder "did that work," the product states the answer
    plainly. This applies permanently, to every future feature that touches
    money, predictions, or identity.
15. **Build for the friend group you already have, not the audience you
    might have someday.** Every feature is evaluated against whether it
    would make sense in a five-person invite-only circle before it's ever
    evaluated against how it scales to fifty thousand strangers.

## Founder Checklist

*Every new feature request runs this gauntlet before a single line of
design or code exists. Any hard "no" ends the conversation regardless of
how many other questions score well.*

**Hard gates — a single "no" here kills the idea outright:**

- Does this avoid introducing odds, spreads, or variable stakes? *(If no —
  reject, no exceptions.)*
- Does this avoid rewarding volume, spend, or time-in-app over being right?
  *(If no — reject, this is gambling psychology by another name.)*
- Can this be explained in the same breath as the one-sentence identity?
  *(If no — reject or redesign until it can.)*

**Scoring questions — weigh honestly, in this order:**

1. Does this make brohda. easier to explain, not harder?
2. Does this create conversation between real people, not just interaction
   with the system?
3. Does this strengthen someone's identity or reputation, rather than
   sitting beside it as an unrelated feature?
4. Does this create a story someone would tell a friend?
5. Would people genuinely miss it if it were removed six months from now?
6. Would someone screenshot the result of this feature?
7. Would this survive a Steve-Jobs-style 30% cut, or is it the kind of
   thing that gets cut in that exercise?
8. Would Instagram, Strava, or Chess.com ship something shaped like this —
   or would they consider it clutter?
9. Does this violate KISS in any way that isn't justified by a genuinely
   new emotional payoff?
10. Do we, honestly, believe users would *love* this — not tolerate it, not
    find it useful, but love it?

**The final question, asked last, every time:** should we build this? If
the answer to every scoring question above is a confident yes, and both
hard gates are clear — yes. If more than two scoring questions are a shrug
rather than a yes — the idea isn't ready, and the right move is to simplify
it further, not to build a weaker version of it anyway.
