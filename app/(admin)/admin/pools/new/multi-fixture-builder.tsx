"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  createPoolsForFixturesAction,
  type CreatePoolsForFixturesResult,
} from "@/lib/actions/pools";
import { MINIMUM_POOL_ENTRIES, MINIMUM_LOCK_LEAD_MINUTES } from "@/lib/validations/pools";
import { getTemplateEligibility } from "@/lib/pools/templates";
import { getLatestTemplate } from "@/lib/pools/templates/registry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  ALL_CARDS,
  CATEGORY_LABELS,
  GRADING_BADGE,
  SELECT_CLASS,
  TABS,
  isLegacyId,
  type CardCategory,
  type FixtureOption,
} from "./template-cards";
import { cn } from "@/lib/utils";

// Player props bake in one specific fixture's roster (a picked player's
// external id, fetched via lib/actions/squads.ts once a single fixture is
// known) and COMBO pools are free-typed text tied to one match — neither
// is portable across different fixtures, so both are hidden here. Every
// other template only uses TEAM_SIDE/INTEGER/BOOLEAN config, which is
// generic ("home team", "2.5", "yes/no") and applies identically
// regardless of which two teams are actually playing.
const MULTI_TABS = TABS.filter((cat) => cat !== "COMBO" && cat !== "PLAYER_PROPS");
const MULTI_CARDS = ALL_CARDS.filter((c) => c.category !== "COMBO" && c.category !== "PLAYER_PROPS");

const MULTI_STEP_LABELS = ["Fixtures", "Template", "Financials & review"];

// Stands in for whichever fixture a pool actually ends up on — each
// selected fixture supplies its own real team names server-side
// (createPoolForFixture, lib/actions/pools.ts), so the exact wording here
// only matters for this client-side preview.
const PLACEHOLDER_SCORE = {
  homeTeamName: "Home team",
  awayTeamName: "Away team",
  homeTeamExternalId: null,
  awayTeamExternalId: null,
  regulationHomeScore: null,
  regulationAwayScore: null,
  halftimeHomeScore: null,
  halftimeAwayScore: null,
};

export function MultiFixtureBuilder({
  fixtures,
  defaultEntryFee = "5.00",
  defaultHouseFeePercent = "5",
}: {
  fixtures: FixtureOption[];
  defaultEntryFee?: string;
  defaultHouseFeePercent?: string;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [search, setSearch] = useState("");
  const [selectedFixtureIds, setSelectedFixtureIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<CardCategory>(MULTI_TABS[0]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [entryFee, setEntryFee] = useState(defaultEntryFee);
  const [houseFeePercent, setHouseFeePercent] = useState(defaultHouseFeePercent);
  const [lockMinutes, setLockMinutes] = useState(String(MINIMUM_LOCK_LEAD_MINUTES));
  const [visibility, setVisibility] = useState("VISIBLE_TO_ALL_MEMBERS");
  const [participationVisibility, setParticipationVisibility] = useState("SHOW_BEFORE_ENTRY");
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<CreatePoolsForFixturesResult[] | null>(null);
  const [isPending, startTransition] = useTransition();

  const filteredFixtures = useMemo(() => {
    if (!search.trim()) return fixtures;
    const q = search.trim().toLowerCase();
    return fixtures.filter((f) => f.label.toLowerCase().includes(q));
  }, [fixtures, search]);

  const selectedFixtures = useMemo(
    () => fixtures.filter((f) => selectedFixtureIds.has(f.id)),
    [fixtures, selectedFixtureIds],
  );

  const allVisibleSelected =
    filteredFixtures.length > 0 && filteredFixtures.every((f) => selectedFixtureIds.has(f.id));

  function toggleFixture(id: string) {
    setSelectedFixtureIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedFixtureIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        filteredFixtures.forEach((f) => next.delete(f.id));
      } else {
        filteredFixtures.forEach((f) => next.add(f.id));
      }
      return next;
    });
  }

  // A legacy card is only selectable when every currently-selected fixture
  // qualifies — mixing a knockout fixture with a league fixture in the same
  // batch means neither "Who will advance?" nor "Result after regulation"
  // is safe to apply to all of them at once.
  const whoWillAdvanceEnabled =
    selectedFixtures.length > 0 &&
    selectedFixtures.every((f) => getTemplateEligibility(f.competitionType).whoWillAdvanceEnabled);
  const regulationResultEnabled =
    selectedFixtures.length > 0 &&
    selectedFixtures.every((f) => getTemplateEligibility(f.competitionType).regulationResultEnabled);

  const isLegacy = selectedCardId != null && isLegacyId(selectedCardId);
  const registryTemplate = selectedCardId && !isLegacy ? getLatestTemplate(selectedCardId) : null;

  function selectCard(card: (typeof MULTI_CARDS)[number]) {
    if (card.id === "WHO_WILL_ADVANCE" && !whoWillAdvanceEnabled) return;
    if (card.id === "REGULATION_RESULT" && !regulationResultEnabled) return;

    setSelectedCardId(card.id);
    setConfigValues({});
    if (isLegacyId(card.id)) return;

    const template = getLatestTemplate(card.id);
    if (template) {
      const defaults: Record<string, string> = {};
      for (const field of template.requiredConfigFields) {
        if (field.type === "TEAM_SIDE") defaults[field.key] = "HOME";
        else if (field.type === "INTEGER") defaults[field.key] = String(field.min);
        else if (field.type === "BOOLEAN") defaults[field.key] = "false";
      }
      setConfigValues(defaults);
    }
  }

  const typedTemplateConfig = useMemo(() => {
    if (!registryTemplate) return {};
    const config: Record<string, unknown> = {};
    for (const field of registryTemplate.requiredConfigFields) {
      const raw = configValues[field.key];
      config[field.key] =
        field.type === "INTEGER" ? Number(raw) : field.type === "BOOLEAN" ? raw === "true" : raw;
    }
    return config;
  }, [registryTemplate, configValues]);

  const registryConfigValid = registryTemplate
    ? registryTemplate.requiredConfigFields.every((field) => {
        if (field.type === "TEAM_SIDE") return configValues[field.key] === "HOME" || configValues[field.key] === "AWAY";
        if (field.type === "BOOLEAN") return configValues[field.key] === "true" || configValues[field.key] === "false";
        // PLAYER never appears here — MULTI_CARDS excludes PLAYER_PROPS.
        if (field.type === "PLAYER") return false;
        const raw = configValues[field.key];
        const n = Number(raw);
        return raw !== undefined && raw !== "" && !Number.isNaN(n) && n >= field.min && n <= field.max;
      })
    : true;

  const registryQuestion =
    registryTemplate && registryConfigValid
      ? registryTemplate.questionBuilder(PLACEHOLDER_SCORE, typedTemplateConfig)
      : "";

  const previewOptions: string[] =
    selectedCardId === "WHO_WILL_ADVANCE"
      ? ["Home team", "Away team"]
      : selectedCardId === "REGULATION_RESULT"
        ? ["Home team", "Draw", "Away team"]
        : registryTemplate
          ? ["Yes", "No"]
          : [];

  const step1Valid = selectedFixtureIds.size >= 2;
  const step2Valid = registryTemplate ? registryConfigValid : selectedCardId != null;
  const lockMinutesNum = Number(lockMinutes);
  const lockMinutesValid = Number.isFinite(lockMinutesNum) && lockMinutesNum >= MINIMUM_LOCK_LEAD_MINUTES;
  const step3Valid = entryFee.trim().length > 0 && houseFeePercent.trim().length > 0 && lockMinutesValid;

  function goToStep(target: 1 | 2 | 3) {
    if (target === 2 && !step1Valid) return;
    if (target === 3 && (!step1Valid || !step2Valid)) return;
    setStep(target);
  }

  function submit() {
    if (!selectedCardId) return;
    setSubmitError(null);
    setResults(null);
    const poolType = registryTemplate ? "TEMPLATE_GRADED" : (selectedCardId as "WHO_WILL_ADVANCE" | "REGULATION_RESULT");
    startTransition(async () => {
      const response = await createPoolsForFixturesAction({
        poolType,
        fixtureIds: [...selectedFixtureIds],
        entryFee,
        houseFeePercent,
        visibility,
        participationVisibility,
        lockMinutesBeforeKickoff: lockMinutesNum,
        templateId: registryTemplate?.id,
        templateConfig: registryTemplate ? typedTemplateConfig : undefined,
        publishImmediately,
      });
      if (response.error) {
        setSubmitError(response.error);
        return;
      }
      setResults(response.results);
    });
  }

  // Re-submits only the fixtures a first pass flagged with publishing
  // warnings (Question Family/mirror/duplicate — never a hard block), with
  // the admin's explicit go-ahead. Successes/failures from the first pass
  // stay in the results list untouched; only the warned rows get replaced.
  function retryWarnedFixtures(warnedFixtureIds: string[]) {
    if (!selectedCardId || !results) return;
    const poolType = registryTemplate ? "TEMPLATE_GRADED" : (selectedCardId as "WHO_WILL_ADVANCE" | "REGULATION_RESULT");
    startTransition(async () => {
      const response = await createPoolsForFixturesAction({
        poolType,
        fixtureIds: warnedFixtureIds,
        entryFee,
        houseFeePercent,
        visibility,
        participationVisibility,
        lockMinutesBeforeKickoff: lockMinutesNum,
        templateId: registryTemplate?.id,
        templateConfig: registryTemplate ? typedTemplateConfig : undefined,
        publishImmediately,
        overridePublishWarnings: true,
      });
      if (response.error) {
        setSubmitError(response.error);
        return;
      }
      const retried = new Map(response.results.map((r) => [r.fixtureId, r]));
      setResults((prev) => (prev ?? []).map((r) => retried.get(r.fixtureId) ?? r));
    });
  }

  if (results) {
    const succeeded = results.filter((r) => r.poolId);
    const warned = results.filter((r) => !r.poolId && !r.error && r.warnings && r.warnings.length > 0);
    const failed = results.filter((r) => !r.poolId && (r.error || !r.warnings?.length));
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-text-primary">
          {succeeded.length} of {results.length} pool{results.length === 1 ? "" : "s"} created
          {warned.length > 0 ? `, ${warned.length} need review` : ""}
          {failed.length > 0 ? `, ${failed.length} failed` : ""}.
        </p>
        <ul className="space-y-1.5">
          {results.map((result) => {
            const fixture = fixtures.find((f) => f.id === result.fixtureId);
            const label = fixture ? `${fixture.homeTeamName} vs ${fixture.awayTeamName}` : result.fixtureId;
            const hasWarnings = !result.poolId && !result.error && (result.warnings?.length ?? 0) > 0;
            return (
              <li
                key={result.fixtureId}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm",
                  result.poolId
                    ? "border-border-subtle"
                    : hasWarnings
                      ? "border-warning-muted/40 bg-warning-muted/10"
                      : "border-danger/40 bg-danger/5",
                )}
              >
                {result.poolId ? (
                  <>
                    <span className="text-text-primary">{label}</span> —{" "}
                    <Link href={`/admin/pools/${result.poolId}`} className="text-accent-primary underline underline-offset-4">
                      Created
                    </Link>
                  </>
                ) : hasWarnings ? (
                  <>
                    <span className="text-text-primary">{label}</span>
                    <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
                      {result.warnings!.map((w) => (
                        <li key={w.code}>{w.message}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <span className="text-text-primary">{label}</span> —{" "}
                    <span className="text-danger">Failed: {result.error}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {warned.length > 0 && (
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => retryWarnedFixtures(warned.map((r) => r.fixtureId))}
          >
            {isPending ? "Creating…" : `Publish anyway — create ${warned.length} more pool${warned.length === 1 ? "" : "s"}`}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setResults(null);
            setSelectedFixtureIds(new Set());
            setSelectedCardId(null);
            setConfigValues({});
            setStep(1);
          }}
        >
          Create more pools
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="flex items-center gap-2 text-xs font-medium text-text-muted">
        {MULTI_STEP_LABELS.map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          const reachable = n === 1 || (n === 2 && step1Valid) || (n === 3 && step1Valid && step2Valid);
          return (
            <li key={label} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden="true">&rarr;</span>}
              <button
                type="button"
                onClick={() => goToStep(n)}
                disabled={!reachable}
                className={cn(
                  "rounded-full px-2.5 py-1",
                  step === n
                    ? "bg-accent-primary text-white"
                    : reachable
                      ? "bg-surface-secondary text-text-primary"
                      : "cursor-not-allowed opacity-50",
                )}
              >
                {n}. {label}
              </button>
            </li>
          );
        })}
      </ol>

      {/* Step 1 — Select fixtures */}
      <div className={cn("space-y-3", step !== 1 && "hidden")}>
        <div className="space-y-1.5">
          <Label htmlFor="multiFixtureSearch">Search fixtures</Label>
          <Input
            id="multiFixtureSearch"
            placeholder="Team, league, or country…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {filteredFixtures.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAllVisible} />
            Select all ({filteredFixtures.length})
          </label>
        )}
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border-subtle p-1">
          {filteredFixtures.length === 0 && (
            <p className="p-3 text-sm text-text-muted">No fixtures match that search.</p>
          )}
          {filteredFixtures.map((f) => (
            <label
              key={f.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-secondary"
            >
              <Checkbox checked={selectedFixtureIds.has(f.id)} onCheckedChange={() => toggleFixture(f.id)} />
              <span>
                <span className="block font-medium text-text-primary">
                  {f.homeTeamName} vs {f.awayTeamName}
                </span>
                <span className="block text-xs text-text-muted">
                  {f.league ? `${f.league} — ` : ""}
                  {new Date(f.scheduledStartUtc).toLocaleString()}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-text-muted">
          {selectedFixtureIds.size} fixture{selectedFixtureIds.size === 1 ? "" : "s"} selected — pick at least 2 to
          create a pool for each one at once.
        </p>
        <Button type="button" disabled={!step1Valid} onClick={() => goToStep(2)}>
          Next: select template
        </Button>
      </div>

      {/* Step 2 — Select template */}
      <div className={cn("space-y-4", step !== 2 && "hidden")}>
        <p className="text-sm text-text-secondary">{selectedFixtureIds.size} fixtures selected</p>
        <p className="text-xs text-text-muted">
          Player props and custom combos apply to one specific fixture, so they&apos;re not available when
          creating pools for multiple fixtures at once.
        </p>

        <div className="flex gap-1 border-b border-border-subtle">
          {MULTI_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "rounded-t-lg px-3 py-1.5 text-sm font-medium",
                activeTab === tab
                  ? "border-b-2 border-accent-primary text-text-primary"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {CATEGORY_LABELS[tab]}
            </button>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {MULTI_CARDS.filter((c) => c.category === activeTab).map((card) => {
            const disabled =
              (card.id === "WHO_WILL_ADVANCE" && !whoWillAdvanceEnabled) ||
              (card.id === "REGULATION_RESULT" && !regulationResultEnabled);

            return (
              <button
                key={card.id}
                type="button"
                disabled={disabled}
                onClick={() => selectCard(card)}
                className={cn(
                  "rounded-xl border p-3 text-left text-sm transition-colors",
                  disabled
                    ? "cursor-not-allowed border-border-subtle opacity-50"
                    : selectedCardId === card.id
                      ? "border-accent-primary bg-accent-primary/10"
                      : "border-border-subtle hover:bg-surface-secondary",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-text-primary">{card.name}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                      GRADING_BADGE[card.gradingReliability].className,
                    )}
                  >
                    {GRADING_BADGE[card.gradingReliability].label}
                  </span>
                </div>
                <span className="mt-1 block text-xs text-text-muted">{card.description}</span>
                {disabled && (
                  <span className="mt-1 block text-xs text-danger">
                    {card.id === "WHO_WILL_ADVANCE"
                      ? "Not available — not every selected fixture is a knockout match."
                      : "Not available — not every selected fixture allows a draw as a final outcome."}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {isLegacy && (
          <p className="text-xs text-text-muted">
            Question is generated per fixture at creation time, using each fixture&apos;s own teams.
          </p>
        )}

        {registryTemplate && (
          <div className="space-y-3">
            {registryTemplate.requiredConfigFields.map((field) => {
              if (field.type === "TEAM_SIDE") {
                return (
                  <div key={field.key} className="space-y-1.5">
                    <Label>{field.label}</Label>
                    <div className="flex gap-2">
                      {(["HOME", "AWAY"] as const).map((side) => (
                        <button
                          key={side}
                          type="button"
                          onClick={() => setConfigValues((prev) => ({ ...prev, [field.key]: side }))}
                          className={cn(
                            "rounded-lg border px-3 py-1.5 text-sm",
                            configValues[field.key] === side
                              ? "border-accent-primary bg-accent-primary/10 text-text-primary"
                              : "border-border-subtle text-text-secondary hover:bg-surface-secondary",
                          )}
                        >
                          {side === "HOME" ? "Home team" : "Away team"}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              if (field.type === "BOOLEAN") {
                return (
                  <label key={field.key} className="flex items-center gap-2 text-sm text-text-secondary">
                    <Switch
                      checked={configValues[field.key] === "true"}
                      onCheckedChange={(checked) =>
                        setConfigValues((prev) => ({ ...prev, [field.key]: String(checked) }))
                      }
                    />
                    {field.label}
                  </label>
                );
              }
              // PLAYER never appears here — MULTI_CARDS excludes PLAYER_PROPS.
              if (field.type === "PLAYER") return null;
              return (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`multi-config-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`multi-config-${field.key}`}
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={configValues[field.key] ?? ""}
                    onChange={(e) => setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    className="w-32"
                  />
                </div>
              );
            })}
            <div className="space-y-1.5">
              <Label>Generated question (preview)</Label>
              <p className="rounded-lg bg-surface-secondary px-3 py-2 text-sm font-medium text-text-primary">
                {registryConfigValid ? registryQuestion : "Fill in the fields above…"}
              </p>
              <p className="text-xs text-text-muted">
                Each fixture&apos;s own team names replace &ldquo;Home team&rdquo;/&ldquo;Away team&rdquo; when its
                pool is created.
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => goToStep(1)}>
            Back
          </Button>
          <Button type="button" disabled={!step2Valid} onClick={() => goToStep(3)}>
            Next: financials &amp; review
          </Button>
        </div>
      </div>

      {/* Step 3 — Financials & review */}
      <div className={cn("space-y-4", step !== 3 && "hidden")}>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="multiEntryFee">Entry fee ($)</Label>
            <Input
              id="multiEntryFee"
              placeholder="5.00"
              value={entryFee}
              onChange={(e) => setEntryFee(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="multiHouseFeePercent">Platform fee (%)</Label>
            <Input
              id="multiHouseFeePercent"
              placeholder="5"
              value={houseFeePercent}
              onChange={(e) => setHouseFeePercent(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="multiLockMinutes">Lock time (minutes before each fixture&apos;s kickoff)</Label>
          <Input
            id="multiLockMinutes"
            type="number"
            min={MINIMUM_LOCK_LEAD_MINUTES}
            className="w-32"
            value={lockMinutes}
            aria-invalid={!lockMinutesValid}
            onChange={(e) => setLockMinutes(e.target.value)}
          />
          {lockMinutesValid ? (
            <p className="text-xs text-text-muted">
              {`Each pool locks this many minutes before its own fixture's kickoff (minimum ${MINIMUM_LOCK_LEAD_MINUTES}). Needs at least ${MINIMUM_POOL_ENTRIES} entries by lock time, or it's automatically cancelled and everyone is refunded in full.`}
            </p>
          ) : (
            <p role="alert" className="text-xs text-danger">
              {`Must be at least ${MINIMUM_LOCK_LEAD_MINUTES} minutes.`}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="multiVisibility">Visibility</Label>
            <select
              id="multiVisibility"
              className={SELECT_CLASS}
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value="VISIBLE_TO_ALL_MEMBERS">Visible to all members</option>
              <option value="HIDDEN">Hidden (link only)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="multiParticipationVisibility">Show distribution</Label>
            <select
              id="multiParticipationVisibility"
              className={SELECT_CLASS}
              value={participationVisibility}
              onChange={(e) => setParticipationVisibility(e.target.value)}
            >
              <option value="SHOW_BEFORE_ENTRY">Before entry</option>
              <option value="SHOW_AFTER_ENTRY">After entry</option>
              <option value="SHOW_AFTER_LOCK">After lock</option>
              <option value="NEVER_SHOW">Never</option>
            </select>
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface-secondary p-3 text-sm">
          <p className="font-semibold text-text-primary">Preview</p>
          <p className="mt-1 font-medium text-text-primary">{registryTemplate ? registryQuestion : "—"}</p>
          {previewOptions.length > 0 && <p className="text-text-muted">Options: {previewOptions.join(" / ")}</p>}
          <p className="mt-1 text-text-muted">
            Entry ${entryFee || "0.00"} · Platform fee {houseFeePercent || "0"}%
          </p>
          <p className="mt-2 font-medium text-text-primary">
            Will create {selectedFixtureIds.size} pool{selectedFixtureIds.size === 1 ? "" : "s"}:
          </p>
          <ul className="mt-1 list-inside list-disc text-text-muted">
            {selectedFixtures.map((f) => (
              <li key={f.id}>
                {f.homeTeamName} vs {f.awayTeamName}
              </li>
            ))}
          </ul>
        </div>

        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={publishImmediately}
            onChange={(e) => setPublishImmediately(e.target.checked)}
          />
          Publish immediately (skip Draft — players can enter right away)
        </label>

        {submitError && (
          <p role="alert" className="text-sm text-danger">
            {submitError}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => goToStep(2)}>
            Back
          </Button>
          <Button type="button" className="flex-1" disabled={isPending || !step3Valid} onClick={submit}>
            {isPending
              ? "Creating…"
              : publishImmediately
                ? `Create and publish ${selectedFixtureIds.size} pools`
                : `Create ${selectedFixtureIds.size} draft pools`}
          </Button>
        </div>
      </div>
    </div>
  );
}
