# Game Context (Brohda 2.1 M3)

One short line of fact on an upcoming Game, such as *"Minnesota Vikings are 6–0 this season. Detroit Lions have won 3 straight at home. Something has to give."*, computed at read time from the sports data Brohda already stores.

> Game data → deterministic facts → rank facts → render one short line.

There is no model, no web access, no article, no editorial step, no per-Game cost. This replaces the abandoned AI Game Story Engine (PR #128, reverted by PR #129).

## The rule

> If Brohda cannot prove the statement from its stored data, Brohda cannot say it.

A line is optional enrichment. It is never needed for a Post to exist, a Pick to be made, a Confidence stake, Call BS, or grading, and a failure anywhere in Game Context becomes "no line".

## What it can say

| Fact | Example | Needs |
|---|---|---|
| Current streak | "…have won 6 straight." | the team's regular-season Games, uninterrupted back to the streak's end |
| Whole-season record | "…are 6–0 this season." | the streak runs back to the first Game of the season |
| Home-only / road-only streak | "…have lost 4 straight at home." | the team's home (road) Games |
| Last-N record | "…are 8–2 in their last 10." | exactly N counted Games |
| Season series | "…have won both meetings this season." | earlier meetings, all played and scored |

A winning streak may be followed by one connective sentence ("*<opponent>* are trying to stop the streak."). When both teams have a notable winning run: "Something has to give." Nothing else is ever added: no prediction, no recommendation, no motive, no price, no line.

## Where the data comes from

`fixtures` (written by the provider sync): `provider`, `sport`, `season`, `round`, both team external ids, `scheduled_start_utc`, `internal_status`, final scores. The season sync pulls a league's **entire** schedule in one request, so a team's whole season is stored from its first Game.

Audited on production (2026-10-26): NFL — every one of 32 franchises has exactly 17 regular-season fixtures; no fixture without team ids or season; no stale not-started Game. The same audit found that **NBA and NHL fixtures carry no regular-season marker** (`round`, `stage`, `week` are null and the provider's season start date is the first preseason Game), so Game Context is silent for them until a marker exists. See `regularSeason` in `lib/sports-data/sport-registry.ts`.

## How a Game's history is read

For each team, the regular-season Games of the same provider, sport and season scheduled **before** the Game, oldest first (ties broken by id, never by arrival order). Each is exactly one of:

- **RESULT** — COMPLETED with both scores (W, L, or T where the sport can end level);
- **IGNORED** — CANCELLED or POSTPONED: no result, never breaks a sequence;
- **UNSAFE** — anything else before the Game (not started, live, unknown, suspended, abandoned, awarded, COMPLETED without a score, a level final in a sport that cannot end level).

A fact is produced only if its walk is **bounded**: something ends it (the opposite result or a tie) or the history runs out. Meeting an UNSAFE Game first means the fact might be longer, shorter or untrue, so it is not produced. The same rule makes a Game two weeks out (earlier Games still unplayed) get no overall streak, while a home-only streak is unaffected by an unplayed road Game.

A previous season, preseason, postseason, another provider, or a Game that has not started never counts. A tie ends a streak and is never a win or a loss.

## Ranking and rendering

Each fact has a score (a streak scores 10 per Game, a whole-season record +15, a last-N record up to 40 in proportion to its window, a series 30–45). A fact must reach `min_score` (default 30) to be shown. The best fact is primary; the best qualifying fact about the *other* team may be paired with it. Ties resolve by score, then fact priority, then side (home first), then the id of the most recent supporting Game: a total order, so the same data and settings always give the same line.

Wording is a fixed template per fact type (`lib/game-context/render.ts`). If the full wording is longer than `max_chars` (default 140) the next shorter wording is used (pair + connective, pair, single + connective, single); a sentence is never cut, and if even the single fact does not fit there is no line.

## Provenance

Every fact carries `supportingFixtureIds`: the stored Games that prove it, most recent first. The computation returns them with the line (`GameContext.supportingFixtureIds`); the Member UI shows only the text.

## Configuration

`platform_settings.game_context_enabled` (default **false**) and `game_context_config` (jsonb, optional keys: `min_win_streak`, `min_loss_streak`, `min_venue_streak`, `last_n`, `last_n_min_decisive`, `series_enabled`, `pairs_enabled`, `connective_enabled`, `min_score`, `max_chars`). Edited by a Super Admin on **Settings → Brohda → Game Context**, through `admin_set_game_context_policy` (audited as `settings.game_context_policy_updated`, validated in the database, service-role only). The application parses the stored values fail-closed: anything invalid means OFF. Turning it off is the whole rollback; nothing was ever written.

## Cost and performance

Three reads at most per page of Games (settings, the Games, their teams' regular-season history), computed in memory. A 30-Game feed: 2 queries, ~200 rows, ~16 ms on a local database (feed 30 ms → 44 ms). History is read in explicit pages under PostgREST's 1,000-row ceiling, which truncates silently.

## Files

- `lib/game-context/` — `types`, `config`, `history`, `facts`, `rank`, `render`, `compute` (pure) and `repository` (the only database access, read-only).
- `lib/communities/feed.ts` — `withGameContext`, applied to both feed builders; the Post page calls the same `getGameContexts`.
- `supabase/migrations/20260101000217_game_context_policy.sql` — the two settings and the audited function. Numbered 217 because staging holds the abandoned 216.
- Tests: `tests/unit/game-context/`, `tests/integration/game-context.test.ts`, `tests/e2e/game-context.spec.ts`.
