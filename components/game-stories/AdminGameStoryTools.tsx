"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { approveStoryAction, editStoryAction, generateStoryAction, rejectStoryAction, reverifyStoryAction, setStoryConfigAction, withdrawStoryAction, type GameStoryAdminResult } from "@/lib/actions/game-stories-admin";
import type { StoryConfig } from "@/lib/game-stories/types";

const input = "block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary";
const area = "block w-full rounded-md border border-border-subtle bg-surface-primary px-2 py-1.5 text-sm text-text-primary";

function Status({ state }: { state: GameStoryAdminResult | null }) {
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

type ActionFn = (prev: GameStoryAdminResult | null, formData: FormData) => Promise<GameStoryAdminResult>;
function useAdminAction(fn: ActionFn) {
  return useActionState<GameStoryAdminResult | null, FormData>(fn, null);
}

export function GenerateStoryForm({ fixtureId, regenerate, label }: { fixtureId: string; regenerate?: boolean; label: string }) {
  const [state, action, pending] = useAdminAction(generateStoryAction);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-slot="generate-story-form">
      <input type="hidden" name="fixtureId" value={fixtureId} />
      {regenerate && <input type="hidden" name="regenerate" value="1" />}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Researching… this can take a couple of minutes" : label}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function ReviewActions({ revisionId, requiresVerification }: { revisionId: string; requiresVerification: boolean }) {
  const [approveState, approve, approving] = useAdminAction(approveStoryAction);
  const [rejectState, reject, rejecting] = useAdminAction(rejectStoryAction);
  const [verifyState, verify, verifying] = useAdminAction(reverifyStoryAction);
  return (
    <div className="space-y-3" data-slot="review-actions">
      {requiresVerification ? (
        <form action={verify} className="space-y-1">
          <input type="hidden" name="revisionId" value={revisionId} />
          <p className="text-xs text-text-muted">This text was edited by hand. Its facts must be re-checked against the stored evidence before it can be approved.</p>
          <Button type="submit" size="sm" disabled={verifying}>
            {verifying ? "Verifying…" : "Re-verify the facts"}
          </Button>
          <Status state={verifyState} />
        </form>
      ) : null}
      <form action={approve} className="space-y-1">
        <input type="hidden" name="revisionId" value={revisionId} />
        <Button type="submit" size="sm" disabled={approving || requiresVerification}>
          {approving ? "Approving…" : "Approve and put on the Post"}
        </Button>
        <Status state={approveState} />
      </form>
      <form action={reject} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="revisionId" value={revisionId} />
        <label className="min-w-48 flex-1 space-y-1 text-xs font-medium text-text-secondary">
          Reason for rejecting
          <input name="reason" className={input} maxLength={300} required />
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={rejecting}>
          Reject
        </Button>
        <Status state={rejectState} />
      </form>
    </div>
  );
}

export function EditStoryForm({ revisionId, hook, body, maxChars }: { revisionId: string; hook: string; body: string; maxChars: number }) {
  const [state, action, pending] = useAdminAction(editStoryAction);
  return (
    <form action={action} className="space-y-2" data-slot="edit-story-form">
      <input type="hidden" name="revisionId" value={revisionId} />
      <label className="block space-y-1 text-xs font-medium text-text-secondary">
        Hook
        <input name="hook" defaultValue={hook} className={input} maxLength={200} />
      </label>
      <label className="block space-y-1 text-xs font-medium text-text-secondary">
        Body
        <textarea name="body" defaultValue={body} rows={4} className={area} maxLength={800} />
        <span className="block font-normal text-text-muted">Hook and body together must stay under {maxChars} characters. An edit is saved as a new revision and its facts are re-verified before it can be approved.</span>
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Save edit as a new revision
      </Button>
      <Status state={state} />
    </form>
  );
}

export function WithdrawForm({ fixtureId }: { fixtureId: string }) {
  const [state, action, pending] = useAdminAction(withdrawStoryAction);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-slot="withdraw-story-form">
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <label className="min-w-48 flex-1 space-y-1 text-xs font-medium text-text-secondary">
        Reason for taking the story down
        <input name="reason" className={input} maxLength={300} required />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Withdraw from the Post
      </Button>
      <Status state={state} />
    </form>
  );
}

const SPORT_OPTIONS = [
  ["american_football", "NFL / American football"],
  ["basketball", "NBA / Basketball"],
  ["hockey", "NHL / Hockey"],
  ["baseball", "MLB / Baseball (not yet supported by Brohda data)"],
] as const;
const NUMBERS: Array<{ name: string; key: keyof StoryConfig; label: string; help: string }> = [
  { name: "max_chars", key: "maxChars", label: "Story length (characters)", help: "Hook + body together. The database refuses anything longer." },
  { name: "min_score", key: "minScore", label: "Minimum score (0–100)", help: "A candidate below this is rejected. A test threshold, not a constant." },
  { name: "research_window_hours", key: "researchWindowHours", label: "Research window (hours before kickoff)", help: "Only Games starting within this window are researched." },
  { name: "refresh_interval_minutes", key: "refreshIntervalMinutes", label: "Minutes between researching the same Game", help: "Prevents re-researching a Game continuously." },
  { name: "editorial_cutoff_minutes", key: "editorialCutoffMinutes", label: "Editorial cutoff (minutes before kickoff)", help: "No brand-new pregame story is generated this close to kickoff." },
  { name: "max_queries_per_game", key: "maxQueriesPerGame", label: "Web searches per Game", help: "A hard ceiling on research effort (and cost) for one Game." },
  { name: "max_sources", key: "maxSources", label: "Sources kept per Game", help: "The strongest, freshest sources are kept; the rest are recorded as dropped." },
  { name: "max_attempts", key: "maxAttempts", label: "Drafts per run", help: "A rejected angle may be followed by another, up to this many drafts." },
  { name: "provider_retries", key: "providerRetries", label: "Retries on a provider error", help: "Only transient errors (rate limit, overload, timeout) are retried." },
  { name: "request_timeout_seconds", key: "requestTimeoutSeconds", label: "Provider timeout (seconds)", help: "Per model request." },
  { name: "max_games_per_run", key: "maxGamesPerRun", label: "Games per scheduled run", help: "The most Games one scheduled tick researches." },
  { name: "max_runs_per_game", key: "maxRunsPerGame", label: "Scheduled runs per Game", help: "A Game is never researched automatically more than this many times." },
  { name: "status_max_age_hours", key: "statusMaxAgeHours", label: "Injury/availability freshness (hours)", help: "An availability claim needs a dated source at least this recent." },
  { name: "current_fact_max_age_hours", key: "currentFactMaxAgeHours", label: "Current-fact freshness (hours)", help: "A claim about form or the present state needs a source this recent." },
];

export function StoryConfigForm({ config, credentialsConfigured }: { config: StoryConfig; credentialsConfigured: boolean }) {
  const [state, action, pending] = useAdminAction(setStoryConfigAction);
  return (
    <form action={action} className="space-y-4" data-slot="game-story-config-form">
      <div className="space-y-3 rounded-md border border-border-subtle p-3">
        <label className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <input type="checkbox" name="generation_enabled" defaultChecked={config.generationEnabled} className="mt-0.5 size-4" />
          <span>
            Research and write candidate stories
            <span className="block text-xs font-normal text-text-muted">Off by default and the kill switch: off means no research, no model call and no write. Turning it on only produces candidates for your review; nothing is published automatically.</span>
          </span>
        </label>
        <p className="text-xs text-text-muted">
          Automatic publishing: <strong className="text-text-secondary">locked off</strong>. AI provider key: <strong className="text-text-secondary">{credentialsConfigured ? "configured on the server" : "not configured on this environment"}</strong> (the key is never shown or stored here).
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Model
            <input name="model" defaultValue={config.model} className={input} maxLength={100} />
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Effort
            <select name="effort" defaultValue={config.effort} className={input}>
              {["low", "medium", "high", "xhigh", "max"].map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Web search version
            <select name="web_search_tool_version" defaultValue={config.webSearchToolVersion} className={input}>
              {["web_search_20250305", "web_search_20260209", "web_search_20260318"].map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pt-5 text-xs font-medium text-text-secondary">
            <input type="checkbox" name="web_search_enabled" defaultChecked={config.webSearchEnabled} className="size-4" /> Allow web search research
          </label>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-text-secondary">Sports</legend>
          {SPORT_OPTIONS.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" name="supported_sports" value={value} defaultChecked={config.supportedSports.includes(value)} className="size-4" /> {label}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          {NUMBERS.map((n) => (
            <label key={n.name} className="space-y-1 text-xs font-medium text-text-secondary">
              {n.label}
              <input name={n.name} type="number" inputMode="numeric" defaultValue={String(config[n.key])} className={input} />
              <span className="block font-normal text-text-muted">{n.help}</span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Extra preferred domains (local reporting)
            <textarea name="preferred_domains" defaultValue={config.preferredDomains.join("\n")} rows={3} className={area} />
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Extra blocked domains
            <textarea name="blocked_domains" defaultValue={config.blockedDomains.join("\n")} rows={3} className={area} />
          </label>
        </div>
        <p className="text-xs text-text-muted">Source trust is decided in code (official league, official team, structured data, major journalism, local reporting). Sportsbook, social, wiki and forum domains are never evidence and cannot be unblocked here.</p>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        Save story settings
      </Button>
      <Status state={state} />
    </form>
  );
}
