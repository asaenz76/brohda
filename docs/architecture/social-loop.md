# The competitive social loop (Brohda 2.1 M4)

> Pick a side → Talk → Call BS → Result → Record

M4 adds no new mechanic. Picks, comments, Call BS, grading and records already existed and are unchanged; M4 connects them on the Game's one canonical Post so a Member who picks a side can find the disagreement, challenge it, see the outcome and find it again later.

## Where each step lives

| Step | Where | Source of truth |
|---|---|---|
| Pick a side | the Game card in the feed (`FeedMarketPick`, `TwoStepPickComposer`) | `predictions` (one current Pick per Member per Market), `set_pick()` |
| Say why | the Post's conversation (`PostConversation`) | `post_comments`, `add_post_comment()` |
| Which side a commenter argues from | a line under the commenter's name: "Picked Buffalo Bills · Other side" | the commenter's Pick on the Game's primary Market (`predictions`) |
| Call BS | inside the other side's comment (`ChallengeAction`), and in "Other picks" for Members who have not commented | `call_bs()`, `challenges` |
| Answer / see what is waiting, locked, decided | "Your Call BS" at the top of the Post (`CallBsStatusCard`) | `challenges` (status, result, expiry_reason, the stored selection snapshots) |
| Result | the same block (who was right, in words), the Post's final score and "Your prediction … Result", notifications | grading, `resolve-challenges` job |
| Record | the Profile: prediction record, Call BS record, history; "Your Call BS record vs X: 3–1" beside the opponent | derived at read time from RESOLVED `challenges` (`get_call_bs_record`, `getHeadToHeadRecords`); nothing is stored |

## Rules M4 keeps

- A Call BS needs two existing, opposing Picks on the same Market; free; one accepted Call BS is exclusive; accepting locks both teams; Confidence stays separate and can still be attached before T-10; unanswered Call BS expire at T-10; a Pick change cancels a pending one (`EXPIRED / PICK_CHANGED`). All of that is the database's (`call_bs`, `accept_call_bs`, `decline_call_bs`, `expire_stale_challenges`, `set_pick`) and is unchanged.
- The server is authoritative. A button is an offer: eligibility is computed server-side (`getMarketParticipants` → `canCallBs`) and the RPCs re-check everything.
- Commit-before-crowd: a Member with no Pick of their own sees no sides and no controls (the same gate "Other picks" always had).
- Comments belong to the canonical Post. A Game shown in several Communities is still one Post, one conversation, one set of Picks and Call BS.

## Decisions

- **Which Pick a badge shows.** The commenter's *current* Pick on the Market, final once picks lock. There is no per-comment prediction. This matches what Call BS uses (current Picks) and the stored revision history is not needed for it. A Member who changes an editable Pick before T-10 is shown on their new side everywhere, including on earlier comments.
- **One control per Member.** A Member's Call BS control sits on their first visible comment only. Members who have a visible comment are not listed again in "Other picks".
- **Incoming Call BS is answered in one place**, "Your Call BS" (the notification links straight to it, `#call-bs`); the Member's row in the thread only says "Called BS on you".
- **Pending past the deadline reads as expired** (the database sweeps lazily, so the page never trusts `PENDING` alone once T-10 has passed).
- **Copy is in one pure module** (`lib/challenges/presentation.ts`) and nothing in it mentions money.
- **No new counters, no new tables.** Everything shown is derived from the stored rows at read time.
- The Call BS server action refuses a Call BS involving a Member already in an accepted one (it could never be accepted); the Post never offers it.

## Reads

The Post reads each of the following once, however many comments, Picks or Call BS there are: the Market's participants, the viewer's challenges (one query across the Game's Markets), head-to-head records (two queries per 150 opponents), opponent profiles. `tests/integration/social-loop-reads.test.ts` asserts identical call counts for 1 and 12 opponents. The feed adds no reads (its card only changes a link's text from data it already has).

## Files

`lib/challenges/presentation.ts`, `post-social.ts`, `game-status.ts`, `action-state.ts` (`called_on_you`), `repository.ts` (`listChallengesForMarketsAndUser`, `hasAcceptedCallBsAmong`); `lib/post-comments/commenters.ts`; `components/posts/PostConversation.tsx`, `CallBsStatusCard.tsx`, `GamePostCard.tsx` (`conversationNextStep`); `components/predictions/ChallengeAction.tsx`, `MarketParticipants.tsx`; `lib/notifications/links.ts`; `app/(app)/post/[id]/page.tsx`.
Tests: `tests/unit/challenges/`, `tests/unit/post-comments/commenters.test.ts`, `tests/unit/post-conversation-social.test.tsx`, `tests/unit/game-post-card-next-step.test.ts`, `tests/unit/call-bs-action-guard.test.ts`, `tests/integration/social-loop*.test.ts`, `tests/e2e/social-loop.spec.ts`.
