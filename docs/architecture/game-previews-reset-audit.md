# Game Preview pipeline reset — audit (r109)

Written BEFORE any reset code was changed. The controlling document is the owner's "Game Preview editorial contract" (reset brief). This audit classifies every rule that can currently reject, delay or hide a Preview:

- **A** required by the canonical contract · **B** useful but should be advisory · **C** redundant · **D** overly strict / false-positive prone · **E** obsolete after the reset

## 1. The architecture as it stands (main + #106)

| Part | Where | What it does |
|---|---|---|
| Identity | `automation.ts loadGame` | `GameIdentity` = fixture id, sport, competition, teams, UTC kickoff, `asOf`. **No season identifier, no competition phase, no local start time** (the fixtures table has `season`, `round`, `venue_timezone`; they are not passed on). |
| Research | `providers/anthropic.ts research()` | Claude + server-side web search (tool version, ceiling, blocked domains stored in `game_preview_config`); ~25 accreted prompt paragraphs; returns facts (claim, excerpt, kind current/historical, season scope, source type, page context/season, team, flags ambiguous/surprising/disputed), leads, conflicts. Reads search-result page content; there is **no separate page-open tool**. |
| Angles | `selectAngle()` | 3–5 candidate stories, scores, selected id; `dedupeAngles`, `chooseAngle` (history-only / records fallback only when no current story clears `min_story_score`), `orderAnglePrimary`. |
| Fact verifier | `verifyFacts()` | Exceptions only: evidence-first call (no search) then one targeted search. |
| Writer | `write()` | hook + preview + claims (fact ids); prompt carries a 700/120 limit, a hook limit, style examples, ~14 rules. |
| Reviewer | `verify()` | blocking (12 categories) vs advisory (6 kinds); extra rules for history-only stories. |
| Deterministic gates | `validation.ts`, `editorial.ts`, `pipeline.ts` | See §2. |
| Rewrite loop | `pipeline.ts` | blocking → feedback + rewrite (max attempts 3); valid draft with advisory notes → ONE polish rewrite, fallback to the earlier valid draft. |
| Search budget | `pipeline.ts verificationReserve` | ceiling 6; research gets ceiling − floor(ceiling/3) when a fact verifier exists; remainder rolls over. |
| Provenance | `game_preview_sources` (primary first, `position`), `claims` jsonb, `generation_meta`, `game_preview_runs.details`, `game_preview_revisions` | Kept. |
| Persistence | `upsert_game_preview` (migrations 206–208) | DB outcomes: `invalid_text`, `hook_too_long`, `body_too_long`, `invalid_sources`, `invalid_claims`, `invalid_meta`, `game_started`, `frozen`, `too_soon`, `not_stale`, `already_exists`, `fixture_not_found`, `invalid_generator`, `invalid_reason`. |
| Public footer | `GamePreviewSection`, `derivePublicSources` | "Source: Publisher · date" (+ one "Also"), betting primary hidden. |
| Admin | `/admin/game-previews`, `AdminGamePreviewTools` | Per-Game Generate/Regenerate/Edit/Withdraw, stored settings, run details. |
| Automation | `generation_enabled=false` | `runGamePreviewAutomation` is a no-op while OFF; admin runs are explicit. No request-time generation anywhere. |
| Settings | `game_preview_config` | max_chars 700, hook_max_chars (CHECK 20–300; now 140), lead/stale hours, provider/model/effort, web search + tool version, verify_with_model, max_attempts 3, max_games_per_run, max_search_calls 6, current_fact_max_age_hours 72, max_cited_facts 4, min_story_score 3.0, preferred (trusted) / blocked domains. |
| Tests | `tests/unit/game-previews/*` (5 files), `tests/integration/game-preview*.test.ts`, `tests/e2e/game-preview-post.spec.ts` | |

## 2. Every rule that can reject a Preview

### 2.1 Run-level exits (`pipeline.ts`)

| Rule | Class | Decision |
|---|---|---|
| `model_not_configured`, `web_search_disabled` | A | keep (configuration invariants) |
| `game_not_eligible` (not NOT_STARTED / already started) | A | keep: "no generation after Game start" |
| `research_did_not_search` | A | keep: research must be real |
| `no_verified_facts` (0 facts) | A | keep |
| `no_usable_facts` (current-state facts undated or older than `current_fact_max_age_hours` are **excluded**) | D | **replace**: staleness is an *exception to investigate* (contract §6), not an exclusion. Undated/old current-state facts become verification exceptions; unresolved ones kill only their story. |
| `angle_selection_invalid` (3–5 angles, unknown type, score range, fact ids, selected id) | D | **simplify** to structural only: ≥1 usable angle; coerce unknown types; clamp scores; drop angles citing unknown facts. |
| `no_trusted_primary_source` | A | keep (source eligibility, deterministic) |
| `story_not_verified` (an exception fact fails verification) | A | keep |
| `fact_verification_failed`, `research_failed`, `writer_failed`, `verifier_failed` | technical | keep; recorded with the provider error |
| `no_public_source` | A | keep |
| `draft_rejected` (blocking after all attempts) | A | keep; now only for real blocking findings |
| *(new)* `needs_review: game_mismatch` | A | NEW: contract §3 — research reports a schedule/season/phase conflict → `needs_review`, never silently switch Games |
| *(new)* `needs_review: <reason>` from the writer | A | NEW: contract §27 |

### 2.2 `validateDraft` (`validation.ts`)

| Rule | Class | Decision |
|---|---|---|
| hook non-empty / caption non-empty | A | keep (shape) |
| **hook ≤ `hook_max_chars`** | E | **remove** (contract §18: no secondary hook limit). The DB still checks the column against the stored value, so the stored value is set to its maximum (300) in Admin; no migration. |
| caption ≤ `max_chars` | A | **change**: title + caption combined **< `max_chars`** (700), exact count in code |
| ≥1 claim; claim has text; claim cites a fact; cited id exists | A | keep (claim → source map is the provenance contract) |
| cited fact from blocked domain; unusable URL | A | keep |
| **cited current-state fact undated / older than the window** | C | **remove**: duplicates `splitUsableFacts` (replaced by exceptions) |
| **figure in claim/text not in cited facts** (`claimedFigures`) | D | **demote to a HINT** to the reviewer (semantic judgement of `wrong_figure`); only digits, only when no reviewer is configured, stay deterministic |
| **"this season" without a fact saying so** (`SEASON_QUALIFIER`) | D | **demote to a HINT** to the reviewer (`wrong_season`) |
| quote not in a cited passage | A | keep (fabricated quote; deterministic and low false-positive) |
| **must name either team** (`teamTokens`) | C/D | **remove**: city/nickname false positives; Game identity is the reviewer's `wrong_game` |

### 2.3 `validateEditorial` (`editorial.ts`)

| Rule | Class | Decision |
|---|---|---|
| primary fact must be cited | A | keep (the credit must be what the story rests on) |
| facts outside the chosen story cited | C | **remove**: the writer is only given the story's facts |
| more than `max_cited_facts` cited | B | **advisory** (smallest fact set is guidance, not a gate) |
| earlier-season claim worded "currently/this season" (`CURRENT_FRAMING`) | D | **remove**: semantic → reviewer (`wrong_season`) |
| ambiguous postseason year regex (`ambiguousPostseasonYear`) | D | **remove**: semantic → reviewer (`wrong_season`) |
| time-of-day regex (`TIME_OF_DAY`) | D | **replace**: the Game's local start (with timezone) is now supplied; an unsupported time claim is the reviewer's `unsupported_claim` |
| sportsbook words (`BETTING_WORDS`) | A | keep, **narrowed** to wagering terms (odds, moneyline, point spread, parlay, wager, bet/bets/betting, sportsbook, over/under); "favorite(s)"/"underdog(s)" removed (ordinary sports prose) |
| em dash, hashtag, banned phrases ("epic showdown", "must-watch clash", "both teams want…") | A | **NEW** deterministic style invariants from contract §17 |
| hook states a record; hook of 3+ figures; stat dump; generic phrasing; stock closing question; preview repeats hook | B/E | **remove** the regexes (they only ever produced advisory noise; the reviewer judges taste) |

### 2.4 Season / currentness classification

| Rule | Class | Decision |
|---|---|---|
| model `kind` (current/historical) and `seasonScope` | A | keep (research classification) |
| `reconcileSeasonScope` year/"last season" regex | D | **remove** ("never infer the season from calendar year alone"); keep ONLY the publication-date backstop |
| `currentSeasonStart` publication-date backstop | A | keep, **driven by the supplied season identifier** (first year of `fixtures.season`), not the kickoff's calendar year |
| `reconcileFactKind` (league-rank regex → current) | D | **remove**; league standings are exceptions via the staleness reasons and the reviewer's `stale_current` |
| `splitUsableFacts` | D | **remove** (see `no_usable_facts`) |
| `orderAnglePrimary` (primary among the story's own facts, current-season when the story is) | A | keep |
| `chooseAngle` (history-only only when no current story clears the bar; records fallback) | A | keep: contract §15 |

### 2.5 Reviewer / verifier

| Rule | Class | Decision |
|---|---|---|
| reviewer BLOCKING categories | A | keep; **add** `wrong_phase` (competition phase) and `not_relevant_now` ("why is this relevant to THIS Game NOW?"); advisory never rejects |
| history-only extra review rules | A | keep (now general: present/future claims need a current fact) |
| exception verification reasons | A | keep; add *stale/undated current-state fact* and *league standing* |
| betting page (URL/title) cannot be primary / listed / is an exception | A | keep |

### 2.6 Database (`upsert_game_preview`)

`hook_too_long` (E: neutralised by setting the stored value to 300), `body_too_long` (A: stays as the safety net), `invalid_sources` (A), `invalid_claims` (A; claims may carry extra keys such as `evidence` — verified by the integration test), `game_started`/`frozen` (A), others (A).

### 2.7 Presentation

`derivePublicSources`: betting primary hides the Preview (A); **NEW** a source URL that is a data endpoint (`/apis/`, `site.api.`, `.json`) is not a "story page" and cannot be credited (A, contract §25: link to the original page).

## 3. Existing live Previews (audit of what members can read today)

| Preview | Source / date | Verdict |
|---|---|---|
| Texans @ Jaguars, Titans @ Colts, Saints @ Giants (first pilot, Oct 17) | credit is a raw `site.api.espn.com` JSON scoreboard/schedule endpoint, no date | **Withdraw**: the footer would point at a JSON endpoint, not a supporting story (contract §25). Games have kicked off; not regenerable. |
| Cardinals @ Rams | Washington Post preview, Oct 15 | keep: current, verified claim by claim |
| Chargers @ Chiefs | ESPN story (Oct 15) + KCSN | keep: verified claim by claim |
| Commanders @ 49ers | primary = NBC Sports **betting** odds page | **Withdraw**: betting page is not an eligible primary (contract §24); the story also pairs a defender's absence with the offense (§22) |
| 76ers @ Knicks | nba.com opening-night piece (Aug 11) + NBC Sports Philadelphia (Aug 13) | keep: opening-week/offseason reporting is current context (§9); claims verified |
| Thunder @ Spurs | SI feature, date not captured | keep, flagged: a head-to-head record directly central to the matchup (§7B, §15.3); figure consistent with Stathead (4-4 regular season, 4-3 playoffs) |
| Celtics @ Pistons | ESPN, Mar 6, 2026 | already withdrawn (stale primary story) |

## 4. What the reset does

1. Identity carries **season, competition phase, local start with timezone**; research confirms the matchup and returns `game_check` (mismatch → `needs_review`).
2. One canonical prompt per stage, rewritten from the contract (research, story, writer, reviewer); style rules as data, not accreted paragraphs.
3. Writer returns the contract shape (`status` ready | needs_review, `title`, `caption`, claims with `evidence`).
4. Deterministic code keeps only deterministic facts (listed in §2 "keep"); everything semantic is the reviewer's.
5. Provenance gains per-claim evidence and source dates; nothing is deleted.
6. No migration unless a test proves one is needed.
