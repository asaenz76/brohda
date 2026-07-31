"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { createPoolFromTemplate, type CreatePoolFromTemplateState } from "@/lib/actions/pools";
import { getFixtureGoalsLinesAction } from "@/lib/actions/odds";
import { MINIMUM_POOL_ENTRIES, MINIMUM_LOCK_LEAD_MINUTES } from "@/lib/validations/pools";
import { generatePoolTemplate, getRuleLabel, getTemplateEligibility } from "@/lib/pools/templates";
import { getTemplate } from "@/lib/pools/templates/registry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { PlayerPicker } from "./player-picker";
import { MultiFixtureBuilder } from "./multi-fixture-builder";
import {
  ALL_CARDS,
  CATEGORY_LABELS,
  GRADING_BADGE,
  SELECT_CLASS,
  TABS,
  isLegacyId,
  type CardCategory,
  type FixtureOption,
  type TemplateCard,
} from "./template-cards";
import { cn } from "@/lib/utils";

export type { FixtureOption };

const GOALS_LINE_TEMPLATE_IDS = new Set(["MATCH_TOTAL_GOALS", "FIRST_HALF_TOTAL_GOALS", "TEAM_TOTAL_GOALS"]);

const initialState: CreatePoolFromTemplateState = { error: null };
const MAX_COMBO_LEGS = 10;
const STEP_LABELS = ["Fixture", "Template", "Financials & review"];

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PoolTemplateBuilder({
  fixtures,
  defaultEntryFee = "5.00",
  defaultHouseFeePercent = "5",
}: {
  fixtures: FixtureOption[];
  defaultEntryFee?: string;
  defaultHouseFeePercent?: string;
}) {
  const [state, formAction, pending] = useActionState(createPoolFromTemplate, initialState);
  const [mode, setMode] = useState<"single" | "multi">("single");

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [search, setSearch] = useState("");
  const [fixtureId, setFixtureId] = useState("");
  const [activeTab, setActiveTab] = useState<CardCategory>(TABS[0]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [legs, setLegs] = useState<string[]>(["", ""]);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [entryFee, setEntryFee] = useState(defaultEntryFee);
  const [houseFeePercent, setHouseFeePercent] = useState(defaultHouseFeePercent);
  const [locksAtLocal, setLocksAtLocal] = useState("");
  const [visibility, setVisibility] = useState("VISIBLE_TO_ALL_MEMBERS");
  const [participationVisibility, setParticipationVisibility] = useState("SHOW_BEFORE_ENTRY");
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [goalsLines, setGoalsLines] = useState<{
    forFixtureId: string;
    matchLine: number | null;
    firstHalfLine: number | null;
    homeTeamLine: number | null;
    awayTeamLine: number | null;
  } | null>(null);
  const oddsFetchedForFixtureId = useRef<string | null>(null);

  const locksAtIso = locksAtLocal ? new Date(locksAtLocal).toISOString() : "";
  const selectedFixture = fixtures.find((f) => f.id === fixtureId) ?? null;
  const isCombo = selectedCardId === "COMBO";
  const isLegacy = selectedCardId != null && isLegacyId(selectedCardId);
  const registryTemplate = selectedCardId && !isLegacy ? getTemplate(selectedCardId) : null;
  const eligibility = getTemplateEligibility(selectedFixture?.competitionType ?? null);
  const needsGoalsLine = selectedCardId != null && GOALS_LINE_TEMPLATE_IDS.has(selectedCardId);

  // Fetches the fixture's odds-derived goals suggestion at most once per
  // fixture (not per template switch) — MATCH_TOTAL_GOALS and
  // FIRST_HALF_TOTAL_GOALS both read off the one fetch's two lines.
  useEffect(() => {
    if (!needsGoalsLine || !selectedFixture?.externalFixtureId) return;
    if (oddsFetchedForFixtureId.current === selectedFixture.id) return;
    oddsFetchedForFixtureId.current = selectedFixture.id;
    const fixtureId = selectedFixture.id;
    getFixtureGoalsLinesAction(selectedFixture.externalFixtureId).then((lines) => {
      setGoalsLines({ forFixtureId: fixtureId, ...lines });
    });
  }, [needsGoalsLine, selectedFixture]);

  // Which of the fetch's four suggestions applies to the currently active
  // template (and, for TEAM_TOTAL_GOALS, the currently selected side) —
  // null while the fetch for this fixture hasn't resolved yet.
  function currentGoalsSuggestion(): number | null {
    if (!goalsLines || goalsLines.forFixtureId !== selectedFixture?.id) return null;
    if (selectedCardId === "FIRST_HALF_TOTAL_GOALS") return goalsLines.firstHalfLine;
    if (selectedCardId === "TEAM_TOTAL_GOALS") {
      return configValues.team === "AWAY" ? goalsLines.awayTeamLine : goalsLines.homeTeamLine;
    }
    return goalsLines.matchLine;
  }

  // Pure derived value (no effect/setState) for "minimumGoals" specifically
  // — read by both the field's displayed value and typedTemplateConfig
  // below, so what's shown and what's submitted always agree. Only applies
  // the odds suggestion while the field still holds its untouched default;
  // once the admin edits it, configValues.minimumGoals itself takes over.
  function resolveMinimumGoals(field: { min: number }): string {
    const raw = configValues.minimumGoals ?? String(field.min);
    if (raw !== String(field.min)) return raw;
    if (!needsGoalsLine) return raw;
    const suggested = currentGoalsSuggestion();
    return suggested != null ? String(suggested) : raw;
  }

  // The pool creator can lock earlier than this, never later — the server
  // action re-checks this too (it's the real gate), this is just instant
  // feedback instead of a round trip. String comparison works because
  // toDatetimeLocalValue always produces the same zero-padded
  // YYYY-MM-DDTHH:MM shape, which sorts identically to chronological order.
  const maxLocksAtLocal = selectedFixture
    ? toDatetimeLocalValue(
        new Date(
          new Date(selectedFixture.scheduledStartUtc).getTime() -
            MINIMUM_LOCK_LEAD_MINUTES * 60_000,
        ),
      )
    : "";
  const lockTimeTooLate = Boolean(maxLocksAtLocal) && locksAtLocal > maxLocksAtLocal;

  // Shared summary line for steps 2/3, once a fixture is already picked —
  // the kickoff date/time matters just as much there as in step 1's list
  // (it's what locksAt actually defaults from), not just while browsing.
  const selectedFixtureSummary = selectedFixture
    ? `${selectedFixture.homeTeamName} vs ${selectedFixture.awayTeamName}${
        selectedFixture.league ? ` (${selectedFixture.league})` : ""
      } — ${new Date(selectedFixture.scheduledStartUtc).toLocaleString()}`
    : null;

  const filteredFixtures = useMemo(() => {
    if (!search.trim()) return fixtures;
    const q = search.trim().toLowerCase();
    return fixtures.filter((f) => f.label.toLowerCase().includes(q));
  }, [fixtures, search]);

  function selectFixture(fixture: FixtureOption) {
    setFixtureId(fixture.id);
    const defaultLock = new Date(new Date(fixture.scheduledStartUtc).getTime() - 5 * 60_000);
    setLocksAtLocal(toDatetimeLocalValue(defaultLock));
    // The previous template pick (if any) may no longer be eligible for
    // this fixture's stage, and the auto-filled question is fixture-
    // specific anyway — clear it rather than leave a stale, possibly now-
    // invalid selection in place.
    setSelectedCardId(null);
    setTitle("");
    setQuestion("");
    setConfigValues({});
  }

  function selectCard(card: TemplateCard) {
    if (card.id === "WHO_WILL_ADVANCE" && !eligibility.whoWillAdvanceEnabled) return;
    if (card.id === "REGULATION_RESULT" && !eligibility.regulationResultEnabled) return;

    setSelectedCardId(card.id);
    setConfigValues({});
    if (!selectedFixture) return;

    if (card.id === "COMBO") {
      setTitle(`${selectedFixture.homeTeamName} vs ${selectedFixture.awayTeamName}`);
      setQuestion("");
      return;
    }
    if (isLegacyId(card.id)) {
      const template = generatePoolTemplate(card.id, {
        homeTeamExternalId: selectedFixture.homeTeamExternalId,
        homeTeamName: selectedFixture.homeTeamName,
        homeTeamLogoUrl: selectedFixture.homeTeamLogoUrl,
        awayTeamExternalId: selectedFixture.awayTeamExternalId,
        awayTeamName: selectedFixture.awayTeamName,
        awayTeamLogoUrl: selectedFixture.awayTeamLogoUrl,
      });
      setQuestion(template.question);
      return;
    }
    // Registry template — question is computed live below from
    // configValues, once defaults are seeded (see the effect-free default
    // below: TEAM_SIDE defaults to HOME, INTEGER defaults to its minimum).
    const template = getTemplate(card.id);
    if (template) {
      const defaults: Record<string, string> = {};
      for (const field of template.requiredConfigFields) {
        if (field.type === "TEAM_SIDE") defaults[field.key] = "HOME";
        else if (field.type === "INTEGER") defaults[field.key] = String(field.min);
        else if (field.type === "BOOLEAN") defaults[field.key] = "false";
        // PLAYER has no sensible default — left unset until the picker
        // resolves a real player (see PlayerPicker's onSelect below).
      }
      setConfigValues(defaults);
    }
  }

  function updateLeg(index: number, value: string) {
    setLegs((prev) => prev.map((l, i) => (i === index ? value : l)));
  }

  function removeLeg(index: number) {
    setLegs((prev) => prev.filter((_, i) => i !== index));
  }

  // Typed config object (TEAM_SIDE/PLAYER stay strings, INTEGER becomes a
  // number) — what's actually sent to questionBuilder for the live preview
  // and JSON-stringified into the submitted hidden input. PLAYER is a
  // special case: the picker always stores its selection under the fixed
  // "playerId"/"playerName" keys (see PlayerPicker below) regardless of
  // the field's own `key`, since playerToScoreConfigSchema expects those
  // exact two top-level properties.
  const typedTemplateConfig = useMemo(() => {
    if (!registryTemplate) return {};
    const config: Record<string, unknown> = {};
    for (const field of registryTemplate.requiredConfigFields) {
      if (field.type === "PLAYER") {
        config.playerExternalId = configValues.playerId ?? "";
        config.playerName = configValues.playerName ?? "";
        continue;
      }
      const raw =
        field.key === "minimumGoals" && field.type === "INTEGER"
          ? resolveMinimumGoals(field)
          : configValues[field.key];
      config[field.key] =
        field.type === "INTEGER" ? Number(raw) : field.type === "BOOLEAN" ? raw === "true" : raw;
    }
    return config;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveMinimumGoals closes over these same values, listed explicitly
  }, [registryTemplate, configValues, goalsLines, selectedCardId, selectedFixture?.id, needsGoalsLine]);

  const registryQuestion =
    registryTemplate && selectedFixture
      ? registryTemplate.questionBuilder(
          {
            homeTeamName: selectedFixture.homeTeamName,
            awayTeamName: selectedFixture.awayTeamName,
            homeTeamExternalId: selectedFixture.homeTeamExternalId,
            awayTeamExternalId: selectedFixture.awayTeamExternalId,
            regulationHomeScore: null,
            regulationAwayScore: null,
            halftimeHomeScore: null,
            halftimeAwayScore: null,
          },
          typedTemplateConfig,
        )
      : "";

  const previewOptions: string[] =
    selectedCardId === "WHO_WILL_ADVANCE" && selectedFixture
      ? [selectedFixture.homeTeamName, selectedFixture.awayTeamName]
      : selectedCardId === "REGULATION_RESULT" && selectedFixture
        ? [selectedFixture.homeTeamName, "Draw", selectedFixture.awayTeamName]
        : isCombo || registryTemplate
          ? ["Yes", "No"]
          : [];

  const registryConfigValid = registryTemplate
    ? registryTemplate.requiredConfigFields.every((field) => {
        if (field.type === "TEAM_SIDE") return configValues[field.key] === "HOME" || configValues[field.key] === "AWAY";
        if (field.type === "PLAYER") return Boolean(configValues.playerId) && Boolean(configValues.playerName);
        if (field.type === "BOOLEAN") return configValues[field.key] === "true" || configValues[field.key] === "false";
        const raw = configValues[field.key];
        const n = Number(raw);
        return raw !== "" && !Number.isNaN(n) && n >= field.min && n <= field.max;
      })
    : true;

  const step1Valid = Boolean(fixtureId);
  const step2Valid = isCombo
    ? title.trim().length > 0 &&
      question.trim().length > 0 &&
      legs.filter((l) => l.trim().length > 0).length >= 2
    : registryTemplate
      ? registryConfigValid
      : selectedCardId != null && question.trim().length > 0;
  const step3Valid =
    entryFee.trim().length > 0 &&
    houseFeePercent.trim().length > 0 &&
    locksAtLocal.length > 0 &&
    !lockTimeTooLate;

  function goToStep(target: 1 | 2 | 3) {
    if (target === 2 && !step1Valid) return;
    if (target === 3 && (!step1Valid || !step2Valid)) return;
    setStep(target);
  }

  const submittedPoolType = registryTemplate ? "TEMPLATE_GRADED" : (selectedCardId ?? "");

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex gap-2">
          <Button
            type="button"
            variant={mode === "single" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("single")}
          >
            Single fixture
          </Button>
          <Button
            type="button"
            variant={mode === "multi" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("multi")}
          >
            Multiple fixtures
          </Button>
        </div>

        {mode === "multi" ? (
          <MultiFixtureBuilder
            fixtures={fixtures}
            defaultEntryFee={defaultEntryFee}
            defaultHouseFeePercent={defaultHouseFeePercent}
          />
        ) : (
          <>
        <ol className="flex items-center gap-2 text-xs font-medium text-text-muted">
          {STEP_LABELS.map((label, i) => {
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

        <form action={formAction} className="space-y-5">
          {/* Step 1 — Select Fixture */}
          <div className={cn("space-y-3", step !== 1 && "hidden")}>
            <div className="space-y-1.5">
              <Label htmlFor="fixtureSearch">Search fixtures</Label>
              <Input
                id="fixtureSearch"
                placeholder="Team, league, or country…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border-subtle p-1">
              {filteredFixtures.length === 0 && (
                <p className="p-3 text-sm text-text-muted">No fixtures match that search.</p>
              )}
              {filteredFixtures.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => selectFixture(f)}
                  className={cn(
                    "block w-full rounded-md px-3 py-2 text-left text-sm",
                    f.id === fixtureId
                      ? "bg-accent-primary/10 text-text-primary"
                      : "text-text-secondary hover:bg-surface-secondary",
                  )}
                >
                  <span className="font-medium text-text-primary">
                    {f.homeTeamName} vs {f.awayTeamName}
                  </span>
                  <span className="block text-xs text-text-muted">
                    {f.league ? `${f.league} — ` : ""}
                    {new Date(f.scheduledStartUtc).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
            <Button type="button" disabled={!step1Valid} onClick={() => goToStep(2)}>
              Next: select template
            </Button>
          </div>

          {/* Step 2 — Select Template */}
          <div className={cn("space-y-4", step !== 2 && "hidden")}>
            {selectedFixtureSummary && (
              <p className="text-sm text-text-secondary">{selectedFixtureSummary}</p>
            )}

            <div className="flex gap-1 border-b border-border-subtle">
              {TABS.map((tab) => (
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
              {ALL_CARDS.filter((c) => c.category === activeTab).map((card) => {
                const disabled =
                  (card.id === "WHO_WILL_ADVANCE" && !eligibility.whoWillAdvanceEnabled) ||
                  (card.id === "REGULATION_RESULT" && !eligibility.regulationResultEnabled);

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
                    <span className="mt-1 block text-xs text-text-muted">Data: {card.dataSource}</span>
                    {card.gradingReliability === "NEEDS_LIVE_DATA" && (
                      <span className="mt-1 block text-xs text-text-muted">
                        Grades automatically once match events are being tracked — use Grade Manually
                        if the feed doesn&rsquo;t report it for this match.
                      </span>
                    )}
                    {disabled && (
                      <span className="mt-1 block text-xs text-danger">
                        {card.id === "WHO_WILL_ADVANCE"
                          ? "Not available — this fixture isn't a knockout match."
                          : "Not available — this fixture is a knockout match, so a draw isn't a possible final outcome."}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {isLegacy && !isCombo && (
              <div className="space-y-1.5">
                <Label>Question (auto-filled)</Label>
                <Input value={question} readOnly className="bg-surface-secondary" />
                <p className="text-xs text-text-muted">
                  {getRuleLabel(selectedCardId as "WHO_WILL_ADVANCE" | "REGULATION_RESULT")}
                </p>
              </div>
            )}

            {registryTemplate && selectedFixture && (
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
                              {side === "HOME" ? selectedFixture.homeTeamName : selectedFixture.awayTeamName}
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
                  if (field.type === "PLAYER") {
                    return (
                      <PlayerPicker
                        key={field.key}
                        homeTeamExternalId={selectedFixture.homeTeamExternalId}
                        homeTeamName={selectedFixture.homeTeamName}
                        awayTeamExternalId={selectedFixture.awayTeamExternalId}
                        awayTeamName={selectedFixture.awayTeamName}
                        selectedPlayerId={configValues.playerId ?? ""}
                        selectedPlayerName={configValues.playerName ?? ""}
                        onSelect={(player) =>
                          setConfigValues((prev) => ({
                            ...prev,
                            playerId: player.externalPlayerId,
                            playerName: player.name,
                          }))
                        }
                      />
                    );
                  }
                  return (
                    <div key={field.key} className="space-y-1.5">
                      <Label htmlFor={`config-${field.key}`}>{field.label}</Label>
                      <Input
                        id={`config-${field.key}`}
                        type="number"
                        min={field.min}
                        max={field.max}
                        value={field.key === "minimumGoals" ? resolveMinimumGoals(field) : (configValues[field.key] ?? "")}
                        onChange={(e) =>
                          setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className="w-32"
                      />
                      {field.key === "minimumGoals" && needsGoalsLine && (() => {
                        const stillLoading = !goalsLines || goalsLines.forFixtureId !== selectedFixture?.id;
                        const suggested = stillLoading ? null : currentGoalsSuggestion();
                        if (stillLoading) {
                          return <p className="text-xs text-text-muted">Checking today&apos;s odds…</p>;
                        }
                        if (suggested != null) {
                          return (
                            <p className="text-xs text-text-muted">
                              Prefilled from today&apos;s odds — feel free to change it.
                            </p>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  );
                })}
                <div className="space-y-1.5">
                  <Label>Generated question</Label>
                  <p className="rounded-lg bg-surface-secondary px-3 py-2 text-sm font-medium text-text-primary">
                    {registryConfigValid ? registryQuestion : "Fill in the fields above…"}
                  </p>
                </div>
              </div>
            )}

            {isCombo && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    name="title"
                    placeholder="2026 World Cup Semifinal France – England"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="question">Question</Label>
                  <Input
                    id="question"
                    name="question"
                    placeholder="Will Mbappé, Bellingham, Dembélé score at least 1 goal each?"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Conditions (all must be met for &ldquo;Yes&rdquo; to win)</Label>
                  <div className="space-y-2">
                    {legs.map((leg, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          name="legs"
                          placeholder={`Condition ${i + 1} (e.g. Mbappé scores a goal)`}
                          value={leg}
                          onChange={(e) => updateLeg(i, e.target.value)}
                        />
                        {legs.length > 2 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove condition"
                            onClick={() => removeLeg(i)}
                          >
                            <X className="size-4" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  {legs.length < MAX_COMBO_LEGS && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setLegs((prev) => [...prev, ""])}
                    >
                      Add condition
                    </Button>
                  )}
                  <p className="text-xs text-text-muted">
                    Options are fixed to Yes/No — graded from these conditions, not typed in. Any
                    condition’s player not taking the pitch voids and fully refunds the whole pool.
                  </p>
                </div>
              </>
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

          {/* Step 3 — Financials & Review */}
          <div className={cn("space-y-4", step !== 3 && "hidden")}>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="entryFee">Entry fee ($)</Label>
                <Input
                  id="entryFee"
                  name="entryFee"
                  placeholder="5.00"
                  value={entryFee}
                  onChange={(e) => setEntryFee(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="houseFeePercent">Platform fee (%)</Label>
                <Input
                  id="houseFeePercent"
                  name="houseFeePercent"
                  placeholder="5"
                  value={houseFeePercent}
                  onChange={(e) => setHouseFeePercent(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="locksAt">Lock time</Label>
              <Input
                id="locksAt"
                type="datetime-local"
                value={locksAtLocal}
                max={maxLocksAtLocal || undefined}
                aria-invalid={lockTimeTooLate}
                onChange={(e) => setLocksAtLocal(e.target.value)}
              />
              <input type="hidden" name="locksAt" value={locksAtIso} />
              {lockTimeTooLate ? (
                <p role="alert" className="text-xs text-danger">
                  {`Lock time must be at least ${MINIMUM_LOCK_LEAD_MINUTES} minutes before kickoff.`}
                </p>
              ) : (
                <p className="text-xs text-text-muted">
                  {`Defaults to ${MINIMUM_LOCK_LEAD_MINUTES} minutes before kickoff (the latest allowed) — pick an earlier time if you'd like more notice. Needs at least ${MINIMUM_POOL_ENTRIES} entries by lock time, or it's automatically cancelled and everyone is refunded in full.`}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="visibility">Visibility</Label>
                <select
                  id="visibility"
                  name="visibility"
                  className={SELECT_CLASS}
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                >
                  <option value="VISIBLE_TO_ALL_MEMBERS">Visible to all members</option>
                  <option value="HIDDEN">Hidden (link only)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="participationVisibility">Show distribution</Label>
                <select
                  id="participationVisibility"
                  name="participationVisibility"
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

            {/* Read-only preview of the generated pool — not itself part of
                the submitted form, just a summary of the state above. */}
            <div className="rounded-xl border border-border-subtle bg-surface-secondary p-3 text-sm">
              <p className="font-semibold text-text-primary">Preview</p>
              {selectedFixtureSummary && (
                <p className="text-text-secondary">{selectedFixtureSummary}</p>
              )}
              {title && <p className="text-text-secondary">{title}</p>}
              <p className="mt-1 font-medium text-text-primary">
                {registryTemplate ? registryQuestion : question || "—"}
              </p>
              {previewOptions.length > 0 && (
                <p className="text-text-muted">Options: {previewOptions.join(" / ")}</p>
              )}
              {isCombo && legs.some((l) => l.trim()) && (
                <ul className="mt-1 list-inside list-disc text-text-muted">
                  {legs.filter((l) => l.trim()).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-text-muted">
                Entry ${entryFee || "0.00"} · Platform fee {houseFeePercent || "0"}%
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                name="publishImmediately"
                checked={publishImmediately}
                onChange={(e) => setPublishImmediately(e.target.checked)}
              />
              Publish immediately (skip Draft — players can enter right away)
            </label>

            {state.error && (
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => goToStep(2)}>
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={pending || !step3Valid}>
                {pending
                  ? "Creating…"
                  : publishImmediately
                    ? "Create and publish"
                    : "Create draft pool"}
              </Button>
            </div>
          </div>

          {/* Hidden fields carrying step 1/2 state through to submission,
              regardless of which step is currently visible. question/title
              for WHO_WILL_ADVANCE/REGULATION_RESULT/TEMPLATE_GRADED aren't
              submitted at all — the server derives them itself from the
              fixture (generatePoolTemplate / questionBuilder), same as
              before this rewrite. */}
          <input type="hidden" name="poolType" value={submittedPoolType} />
          <input type="hidden" name="fixtureId" value={fixtureId} />
          {registryTemplate && (
            <>
              <input type="hidden" name="templateId" value={registryTemplate.id} />
              <input type="hidden" name="templateConfig" value={JSON.stringify(typedTemplateConfig)} />
            </>
          )}
        </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
