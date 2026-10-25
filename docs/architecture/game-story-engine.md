# Game Story Engine (Brohda 2.1 M3)

The engine researches an upcoming Game, finds the tension a fan could argue about, verifies every fact, scores the result and offers it to an Admin. **Nothing it produces reaches a Post without an Admin's approval, and publishing is not automatic.**

> Editorial principle: research everything, find the tension, verify the facts, make fans pick a side. Truth over output volume. If there is no supported story, publish nothing.

## Pipeline

```
Game (fixture + canonical Post)
  ├─ structured facts   lib/game-stories/structured-evidence.ts   head-to-head, form, streaks, rest — computed from `fixtures` (never recalled by a model)
  └─ web research       providers/anthropic.ts                    bounded web search; a fact is kept only if its page was actually reached
        ▼
  normalise             evidence.ts + source-policy.ts            classify source, quarantine instruction-like text, dedupe, cap, resolve contradictions
        ▼
  angles (≤4)           prompts.ts / pipeline.ts                   empty list = NO STORY
        ▼  for each angle, up to max_attempts:
  draft → copy rules → atomic claims → deterministic verification → model verification → model scoring
        ▼
  Brohda scoring        scoring.ts                                 validate ranges, deterministic caps, TOTAL computed here (and as a generated DB column)
        ▼
  save (one transaction) save_game_story_run_result               refuses an accepted candidate with an unsupported claim, no claims, a low score or too many characters
        ▼
  Admin review desk     /admin/game-stories                       approve / reject / edit (→ new revision, must be re-verified) / withdraw / regenerate
        ▼
  posts.story_revision_id (the Game's one canonical Post)         only approve_game_story_revision writes it
```

## Invariants (enforced in the database, not only in code)
- Generation is OFF and auto-publish is OFF by default; auto-publish is locked off by a CHECK (`game_story_auto_publish_locked`) until a later, explicitly authorised migration.
- hook + body ≤ `game_story_config.max_chars` (trigger on insert; re-checked at approval).
- `total_score` is a generated column of the five dimensions; an ACCEPTED candidate needs ≥ 1 claim, every claim SUPPORTED and a total ≥ `min_score`.
- One active run per Game (partial unique index); one APPROVED revision per Game (partial unique index); revision text is immutable (an edit is a new revision flagged `requires_verification`).
- Approval is serialised on the Game's Post row, audited, and supersedes — never deletes — the previous approved revision.
- No story table can be read or written by `anon`/`authenticated`; every function is `service_role`-only; the service role cannot delete from these tables.

## Source policy (`source-policy.ts`)
Structured Brohda data 95 · official league 90 · official team 85 · major journalism 75 · configured local reporting 60 · other 40. Sportsbook/odds, social, forums, wikis and aggregators are never evidence. Availability, quote and transaction claims need a source of authority ≥ 60.

## Operating it
- **Switches** (Super Admin, `/admin/game-stories` → Settings): `generation_enabled` is the kill switch. Off ⇒ no candidate query, no model call, no write; pending approved stories stay as they are.
- **Cron**: `GET /api/cron/game-stories` (Bearer `CRON_SECRET`), registered as `game-stories` in the job registry. It needs its own external scheduler entry; until that exists nothing runs. A no-op while generation is off.
- **Credentials**: `ANTHROPIC_API_KEY` in the server environment only. Without it a run fails cleanly with `credentials_missing`; there is no fallback provider.
- **Failure**: a research or model failure closes the run as FAILED with a category. The Game, its Market, Picks, comments and Call BS are never touched.
- **Rollback**: turn generation off. Approved stories remain; withdraw one with "Withdraw from the Post". No down-migration.
- **Legacy Game Previews** (`lib/game-previews/`) are dormant and untouched. If a Game has an approved M3 story the Post shows it instead of the legacy Preview.

## Tests
`tests/unit/game-stories/*` (deterministic rules, provider, settings, payload), `tests/integration/game-story-engine.test.ts` (database invariants, concurrency, end-to-end with fake providers), `tests/e2e/game-story-review.spec.ts` (review desk in a browser), `scripts/m3-migration-rehearsal.sh` (production-shaped migration rehearsal).
