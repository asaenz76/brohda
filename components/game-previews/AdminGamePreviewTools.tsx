"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { editGamePreviewAction, generateGamePreviewAction, setGamePreviewConfigAction, withdrawGamePreviewAction, type GamePreviewAdminResult } from "@/lib/actions/game-previews-admin";
import type { GamePreviewConfig } from "@/lib/game-previews/types";

const input = "block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary";
const area = "block w-full rounded-md border border-border-subtle bg-surface-primary px-2 py-1.5 text-sm text-text-primary";

const NUMBERS: Array<{ name: string; key: keyof GamePreviewConfig; label: string; help: string; min: number; max: number }> = [
  { name: "max_chars", key: "maxChars", label: "Title + caption length (characters)", help: "The title and the caption TOGETHER must be fewer than this. Longer text is refused, never cut.", min: 100, max: 2000 },
  { name: "hook_max_chars", key: "hookMaxChars", label: "Title length ceiling (database)", help: "Not a generation rule: the generator only enforces the combined limit above. The database still refuses a title longer than this, so keep it at 300.", min: 20, max: 300 },
  { name: "lead_hours", key: "leadHours", label: "Prepare a Game this many hours before kickoff", help: "A Game appears in “needs a Preview” once it starts within this many hours.", min: 1, max: 720 },
  { name: "stale_after_hours", key: "staleAfterHours", label: "Stale after (hours)", help: "A Preview not re-checked for this long may be refreshed before kickoff.", min: 1, max: 720 },
  { name: "min_refresh_interval_hours", key: "minRefreshIntervalHours", label: "Minimum hours between refreshes", help: "New information may replace a Preview only after this long, so it is never rewritten continuously.", min: 0, max: 720 },
  { name: "max_attempts", key: "maxAttempts", label: "Writing attempts per Game", help: "A rejected draft is rewritten with the reasons, up to this many times; then nothing is saved.", min: 1, max: 5 },
  { name: "max_games_per_run", key: "maxGamesPerRun", label: "Games per scheduled run", help: "The most Games the scheduled job prepares in one tick (only when automatic generation is on).", min: 1, max: 50 },
  { name: "max_search_calls_per_game", key: "maxSearchCallsPerGame", label: "Web searches per Game", help: "A hard ceiling on research effort (and cost) for one Game.", min: 1, max: 50 },
  { name: "current_fact_max_age_hours", key: "currentFactMaxAgeHours", label: "How recent a “current” source must be (hours)", help: "A claim about the present state (form, injury, lineup) needs a source published within this window; history can use older sources.", min: 1, max: 8760 },
  { name: "max_cited_facts", key: "maxCitedFacts", label: "Most facts one Preview may cite", help: "One Game, one story: a draft citing more is sent back to be cut down.", min: 1, max: 10 },
  { name: "automation_retry_hours", key: "automationRetryHours", label: "Hours before a needs-review Game is retried automatically", help: "Automation never hammers a Game the checks rejected: it tries again after this long (24 = once a day).", min: 1, max: 720 },
  { name: "automation_technical_retry_hours", key: "automationTechnicalRetryHours", label: "Hours before a technical failure is retried automatically", help: "The same for a run that failed technically (provider outage, malformed output).", min: 1, max: 720 },
  { name: "status_refresh_window_hours", key: "statusRefreshWindowHours", label: "Refresh a status-bearing Preview when the Game is within (hours)", help: "A Preview that states a player status is re-checked through the normal pipeline once its status is older than “Stale after”, only this close to the Game.", min: 1, max: 168 },
];

function Status({ state }: { state: GamePreviewAdminResult | null }) {
  return (
    <>
      {state?.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p role="status" className="text-sm text-text-secondary">
          {state.message}
        </p>
      )}
    </>
  );
}

export function GamePreviewConfigForm({ config, credentialsConfigured }: { config: GamePreviewConfig; credentialsConfigured: boolean }) {
  const [state, action, pending] = useActionState<GamePreviewAdminResult | null, FormData>(setGamePreviewConfigAction, null);
  return (
    <form action={action} className="space-y-4" data-slot="game-preview-config-form">
      <div className="space-y-3 rounded-md border border-border-subtle p-3">
        <p className="text-sm font-medium text-text-primary">Writing the Previews</p>
        <label className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <input type="checkbox" name="generation_enabled" defaultChecked={config.generationEnabled} className="mt-0.5 size-4" />
          <span>
            Generate Previews automatically
            <span className="block text-xs font-normal text-text-muted">Off by default. When on, the scheduled job researches and writes Previews for the next Games that need one. You can always generate one by hand below, whatever this says.</span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Provider
            <select name="provider" defaultValue={config.provider} className={input}>
              <option value="anthropic">Anthropic (Claude, with server-side web search)</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Model
            <input name="model" defaultValue={config.model} placeholder="Set a model id" className={input} maxLength={100} />
            <span className="block font-normal text-text-muted">Used for research, choosing the story, writing and checking. Nothing generates until this is set; there is no fallback to another model.</span>
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Effort
            <select name="effort" defaultValue={config.effort} className={input}>
              {["low", "medium", "high", "xhigh", "max"].map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <span className="block font-normal text-text-muted">How hard the model works. Start at medium; raise it only if real testing shows a need.</span>
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Web search version
            <select name="web_search_tool_version" defaultValue={config.webSearchToolVersion} className={input}>
              {["web_search_20250305", "web_search_20260209", "web_search_20260318"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <span className="block font-normal text-text-muted">The provider versions its search tool. If a model rejects one, pick another here — no deploy needed.</span>
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Minimum story score (1–5)
            <input type="number" name="min_story_score" min={1} max={5} step={0.5} defaultValue={config.minStoryScore} className={input} />
            <span className="block font-normal text-text-muted">A candidate story must average at least this to be chosen over a records-only fallback.</span>
          </label>
        </div>
        <p className="text-xs text-text-muted" data-slot="credentials-status">
          Provider credentials: <strong className="text-text-secondary">{credentialsConfigured ? "configured in the environment" : "not configured"}</strong> (the key is read from the environment and is never shown or stored here).
        </p>
        <label className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <input type="checkbox" name="web_search_enabled" defaultChecked={config.webSearchEnabled} className="mt-0.5 size-4" />
          <span>
            Web search
            <span className="block text-xs font-normal text-text-muted">Research is mandatory: with this off nothing is generated.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <input type="checkbox" name="status_refresh_enabled" defaultChecked={config.statusRefreshEnabled} className="mt-0.5 size-4" />
          <span>
            Refresh Previews that state a player status
            <span className="block text-xs font-normal text-text-muted">Player status ages. A scheduled run re-checks such a Preview before its Game, and hides it if the status cannot be confirmed. Previews without a status are never refreshed automatically.</span>
          </span>
        </label>
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Competitions the scheduled job covers
          <textarea name="automation_competitions" defaultValue={config.automationCompetitions.join("\n")} rows={2} className={area} />
          <span className="block font-normal text-text-muted">As stored on the Game (NFL, NBA, NHL), one per line. You can always generate for any Game by hand.</span>
        </label>
        <label className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <input type="checkbox" name="verify_with_model" defaultChecked={config.verifyWithModel} className="mt-0.5 size-4" />
          <span>
            Independent fact-check of every draft
            <span className="block text-xs font-normal text-text-muted">A second pass confirms each statement is supported by the facts it cites. The built-in checks (figures, sources, freshness) always run.</span>
          </span>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {NUMBERS.map((f) => (
          <label key={f.name} className="space-y-1 text-xs font-medium text-text-secondary">
            {f.label}
            <input type="number" name={f.name} min={f.min} max={f.max} defaultValue={config[f.key] as number} className={input} />
            <span className="block font-normal text-text-muted">{f.help}</span>
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Trusted sources (domains)
          <textarea name="preferred_domains" defaultValue={config.preferredDomains.join("\n")} rows={4} className={area} />
          <span className="block font-normal text-text-muted">Approved as the PRIMARY source of a Preview (the one credited publicly): the leagues, ESPN, FOX Sports and other established reporting. Each team&apos;s own site is also trusted. One per line.</span>
        </label>
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Never use (domains)
          <textarea name="blocked_domains" defaultValue={config.blockedDomains.join("\n")} rows={4} className={area} />
          <span className="block font-normal text-text-muted">Social media and similar. A fact from these is dropped and a draft citing one is rejected.</span>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function GeneratePreviewForm({ fixtureId, hasPreview }: { fixtureId: string; hasPreview: boolean }) {
  const [state, action, pending] = useActionState<GamePreviewAdminResult | null, FormData>(generateGamePreviewAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-slot="generate-preview-form">
      <input type="hidden" name="fixture_id" value={fixtureId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Researching and writing… (up to a few minutes)" : hasPreview ? "Regenerate" : "Generate now"}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function EditPreviewForm({ fixtureId, hook, body, maxHook, maxBody }: { fixtureId: string; hook: string; body: string; maxHook: number; maxBody: number }) {
  const [state, action, pending] = useActionState<GamePreviewAdminResult | null, FormData>(editGamePreviewAction, null);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium text-text-secondary">Edit</summary>
      <form action={action} className="mt-2 space-y-2" data-slot="edit-preview-form">
        <input type="hidden" name="fixture_id" value={fixtureId} />
        <input name="hook" defaultValue={hook} maxLength={maxHook} aria-label="Hook" className={input} />
        <textarea name="body" defaultValue={body} maxLength={maxBody} rows={5} aria-label="Preview" className={area} />
        <input name="note" required minLength={3} maxLength={500} placeholder="What you changed and why" aria-label="What you changed and why" className={input} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Save edit"}
          </Button>
          <Status state={state} />
        </div>
      </form>
    </details>
  );
}

export function WithdrawPreviewForm({ fixtureId }: { fixtureId: string }) {
  const [state, action, pending] = useActionState<GamePreviewAdminResult | null, FormData>(withdrawGamePreviewAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-slot="withdraw-preview-form">
      <input type="hidden" name="fixture_id" value={fixtureId} />
      <input name="reason" required minLength={3} maxLength={500} placeholder="Why it is wrong" aria-label="Why this Preview is being withdrawn" className={`${input} max-w-xs`} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Withdrawing…" : "Withdraw"}
      </Button>
      <Status state={state} />
    </form>
  );
}
