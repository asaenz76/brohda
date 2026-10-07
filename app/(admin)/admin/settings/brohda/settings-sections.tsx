"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  updatePredictionSettingsAction,
  updateNotificationSettingsAction,
  updateMarketSettingsAction,
  updateCommunitySettingsAction,
  updateConversationSettingsAction,
  updateCallBsSettingsAction,
  updateSponsorshipSettingsAction,
  updateMonetarySettingsAction,
  updateReputationSettingsAction,
  updateOperationsSettingsAction,
  type BrohdaSettingsActionResult,
} from "@/lib/actions/brohda-settings";
import type {
  PredictionSettings,
  NotificationSettings,
  MarketSettings,
  CommunitySettings,
  ConversationSettings,
  CallBsSettings,
  SponsorshipSettings,
  MonetarySettings,
  ReputationSettings,
  OperationsSettings,
} from "@/lib/admin-settings/types";
import { formatBps, formatCents } from "@/lib/utils/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";

// Milestone R12 (§56-59): section-level Save (one card per domain, one
// Save button per card — never one giant platform-wide Save, per §57),
// each card's own dependent fields all commit atomically together via
// their one Server Action call. Every card independently tracks its own
// `updatedAt` concurrency token and surfaces a distinct, actionable
// message on a stale-write conflict (§42, §59, §74) rather than silently
// retrying or overwriting. Mirrors the pre-existing
// pool-fee-defaults-form.tsx's own card/label/description/input/Save/
// error/success shape exactly.

function FieldRow({ label, description, children, htmlFor }: { label: string; description: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        {/* When the row controls a single input, the label is a real <label> and the description is its accessible description. */}
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium text-text-primary">
            {label}
          </label>
        ) : (
          <p className="text-sm font-medium text-text-primary">{label}</p>
        )}
        <p id={htmlFor ? `${htmlFor}-description` : undefined} className="text-xs text-text-muted">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SectionFeedback({ result }: { result: BrohdaSettingsActionResult | null }) {
  if (!result) return null;
  if (result.success) return <p className="text-sm font-medium text-text-primary">Saved.</p>;
  if (result.conflict) {
    return (
      <p role="alert" className="text-sm font-medium text-warning-muted">
        {result.error} The values below have been refreshed to the current settings.
      </p>
    );
  }
  return (
    <p role="alert" className="text-sm text-danger">
      {result.error}
    </p>
  );
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        {children}
      </CardContent>
    </Card>
  );
}

export function PredictionSettingsSection({ initial, updatedAt }: { initial: PredictionSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updatePredictionSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.predictions);
      }
    });
  }

  return (
    <SectionCard title="Predictions">
      <FieldRow label="Pick lock" description="Players may change their Pick until this many minutes before scheduled kickoff.">
        <Input
          type="number"
          className="w-24"
          value={values.pickLockMinutesBeforeKickoff}
          onChange={(e) => setValues((v) => ({ ...v, pickLockMinutesBeforeKickoff: Number(e.target.value) }))}
        />
      </FieldRow>
      <FieldRow label="Prediction cutoff before market close" description="Minutes before a Market's own close time when a new prediction stops being accepted.">
        <Input
          type="number"
          className="w-24"
          value={values.predictionCutoffMinutesBeforeClose}
          onChange={(e) => setValues((v) => ({ ...v, predictionCutoffMinutesBeforeClose: Number(e.target.value) }))}
        />
      </FieldRow>
      <FieldRow label="Allow repeat predictions" description="Allow a user to submit more than one Pick on the same Market over time.">
        <Switch checked={values.predictionAllowRepeat} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionAllowRepeat: checked }))} />
      </FieldRow>
      <FieldRow label="Allow predicting on a stale price" description="Allow a Pick when the displayed price is stale but not entirely unavailable.">
        <Switch checked={values.predictionAllowStalePrice} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionAllowStalePrice: checked }))} />
      </FieldRow>
      <FieldRow label="Allow predicting with no price" description="Allow a Pick when no usable price is available for the Market at all.">
        <Switch checked={values.predictionAllowUnavailablePrice} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionAllowUnavailablePrice: checked }))} />
      </FieldRow>
      <FieldRow label="Allow predicting on a closed Market" description="Allow a Pick after the Market has closed. A RESOLVED Market is never predictable regardless of this setting.">
        <Switch checked={values.predictionAllowClosedMarket} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionAllowClosedMarket: checked }))} />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Predictions"}
      </Button>
    </SectionCard>
  );
}

export function NotificationSettingsSection({ initial, updatedAt }: { initial: NotificationSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateNotificationSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.notifications);
      }
    });
  }

  return (
    <SectionCard title="Notifications">
      <FieldRow label="Send grading notifications" description="Master switch for the optional 'your prediction was graded' notification. Grading itself always happens either way.">
        <Switch checked={values.predictionNotificationsEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionNotificationsEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Notify on correct" description="Send a notification when a Pick grades CORRECT.">
        <Switch checked={values.predictionNotifyOnCorrect} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionNotifyOnCorrect: checked }))} />
      </FieldRow>
      <FieldRow label="Notify on incorrect" description="Send a notification when a Pick grades INCORRECT.">
        <Switch checked={values.predictionNotifyOnIncorrect} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionNotifyOnIncorrect: checked }))} />
      </FieldRow>
      <FieldRow label="Notify on void" description="Send a notification when a Pick grades VOID.">
        <Switch checked={values.predictionNotifyOnVoid} onCheckedChange={(checked) => setValues((v) => ({ ...v, predictionNotifyOnVoid: checked }))} />
      </FieldRow>
      <div className="space-y-3 border-t border-border-subtle pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Copy — supports the {"{{question}}"} placeholder</p>
        {(
          [
            ["Correct — title", "predictionNotifyTitleCorrect"],
            ["Correct — body", "predictionNotifyBodyCorrect"],
            ["Incorrect — title", "predictionNotifyTitleIncorrect"],
            ["Incorrect — body", "predictionNotifyBodyIncorrect"],
            ["Void — title", "predictionNotifyTitleVoid"],
            ["Void — body", "predictionNotifyBodyVoid"],
          ] as const
        ).map(([label, key]) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={key}>{label}</Label>
            <Input id={key} value={values[key]} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
          </div>
        ))}
      </div>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Notifications"}
      </Button>
    </SectionCard>
  );
}

export function MarketSettingsSection({ initial, updatedAt }: { initial: MarketSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateMarketSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.markets);
      }
    });
  }

  return (
    <SectionCard title="Markets">
      <FieldRow label="Market ingestion" description="Master switch for automatically ingesting new sports Markets from the configured provider.">
        <Switch checked={values.marketIngestionEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, marketIngestionEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Minimum bookmaker count" description="A proposition must be quoted by at least this many independent bookmakers before it is ingested.">
        <Input
          type="number"
          className="w-24"
          value={values.marketIngestionMinBookmakerCount}
          onChange={(e) => setValues((v) => ({ ...v, marketIngestionMinBookmakerCount: Number(e.target.value) }))}
        />
      </FieldRow>
      <FieldRow label="Post publication" description="Master switch for automatically publishing a Post once its underlying Market/Game is ready.">
        <Switch checked={values.postPublicationEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, postPublicationEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Require an active Market to publish" description="Whether a Post may only publish once it has at least one ACTIVE Market.">
        <Switch checked={values.postPublicationRequiresActiveMarket} onCheckedChange={(checked) => setValues((v) => ({ ...v, postPublicationRequiresActiveMarket: checked }))} />
      </FieldRow>
      <FieldRow label="Social prediction access" description="Whether ordinary users can reach Brohda 2.0's social prediction experience (Markets, Posts, Communities, Picks). Super Admin/Admin always retain preview access. This is the DEPLOY vs ACTIVATE boundary.">
        <Switch checked={values.socialPredictionEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, socialPredictionEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Feed retention for completed games (hours)" description="How long a finished game's Post stays visible in the discovery feed before dropping out. Grading/reputation/notifications are unaffected.">
        <Input
          type="number"
          min={0}
          value={values.feedCompletedGameRetentionHours}
          onChange={(e) => setValues((v) => ({ ...v, feedCompletedGameRetentionHours: Number(e.target.value) }))}
        />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Markets"}
      </Button>
    </SectionCard>
  );
}

export function CommunitySettingsSection({ initial, updatedAt }: { initial: CommunitySettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateCommunitySettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.communities);
      }
    });
  }

  return (
    <SectionCard title="Communities">
      <FieldRow label="Community distribution" description="Master switch for distributing Posts into Communities. Never deletes or rewrites existing relationships — only stops new distribution.">
        <Switch checked={values.communityDistributionEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, communityDistributionEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Team Communities" description="Distribute new Posts into TEAM Communities (only relevant while distribution overall is enabled).">
        <Switch checked={values.communityTeamDistributionEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, communityTeamDistributionEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="League Communities" description="Distribute new Posts into LEAGUE Communities.">
        <Switch checked={values.communityLeagueDistributionEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, communityLeagueDistributionEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Sport Communities" description="Distribute new Posts into SPORT Communities.">
        <Switch checked={values.communitySportDistributionEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, communitySportDistributionEnabled: checked }))} />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Communities"}
      </Button>
    </SectionCard>
  );
}

export function ConversationSettingsSection({ initial, updatedAt }: { initial: ConversationSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateConversationSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.conversation);
      }
    });
  }

  return (
    <SectionCard title="Conversation">
      <FieldRow label="Max comment length" description="Maximum characters allowed in a Post comment. A separate technical database limit of 2000 always applies regardless.">
        <Input type="number" className="w-24" value={values.postCommentMaxLength} onChange={(e) => setValues((v) => ({ ...v, postCommentMaxLength: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Rate-limit window (seconds)" description="Time window over which the comment attempt cap below applies.">
        <Input
          type="number"
          className="w-24"
          value={values.postCommentRateLimitWindowSeconds}
          onChange={(e) => setValues((v) => ({ ...v, postCommentRateLimitWindowSeconds: Number(e.target.value) }))}
        />
      </FieldRow>
      <FieldRow label="Rate-limit attempts" description="Maximum comments a single user may post within the window.">
        <Input
          type="number"
          className="w-24"
          value={values.postCommentRateLimitMaxAttempts}
          onChange={(e) => setValues((v) => ({ ...v, postCommentRateLimitMaxAttempts: Number(e.target.value) }))}
        />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Conversation"}
      </Button>
    </SectionCard>
  );
}

export function CallBsSettingsSection({ initial, updatedAt }: { initial: CallBsSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateCallBsSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.callBs);
      }
    });
  }

  return (
    <SectionCard title="Call BS">
      <FieldRow label="Call BS" description="Master switch for creating new free Call BS Challenges. Never affects an already-PENDING/ACCEPTED Challenge's own lifecycle.">
        <Switch checked={values.callBsEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, callBsEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Rate-limit window (seconds)" description="Time window over which the Call BS creation attempt cap below applies.">
        <Input type="number" className="w-24" value={values.callBsRateLimitWindowSeconds} onChange={(e) => setValues((v) => ({ ...v, callBsRateLimitWindowSeconds: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Rate-limit attempts" description="Maximum Call BS Challenges a single user may create within the window.">
        <Input type="number" className="w-24" value={values.callBsRateLimitMaxAttempts} onChange={(e) => setValues((v) => ({ ...v, callBsRateLimitMaxAttempts: Number(e.target.value) }))} />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Call BS"}
      </Button>
    </SectionCard>
  );
}

export function MonetarySettingsSection({ initial, updatedAt }: { initial: MonetarySettings; updatedAt: string }) {
  const [enabled, setEnabled] = useState(initial.monetaryP2pEnabled);
  const [windowSeconds, setWindowSeconds] = useState(initial.monetaryProposalRateLimitWindowSeconds);
  const [maxAttempts, setMaxAttempts] = useState(initial.monetaryProposalRateLimitMaxAttempts);
  const [feePercent, setFeePercent] = useState((initial.p2pFeeBps / 100).toString());
  const [minStake, setMinStake] = useState((initial.monetaryP2pMinStakeCents / 100).toFixed(2));
  const [maxStake, setMaxStake] = useState((initial.monetaryP2pMaxStakeCents / 100).toFixed(2));
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    // §21: a dangerous, high-impact change (disabling P2P entirely)
    // gets deliberate confirmation — routine field edits do not.
    if (initial.monetaryP2pEnabled && !enabled && !window.confirm("Turn off Monetary P2P? New proposals and new acceptances will be blocked immediately. Already-committed Positions still settle normally and reservations still resolve — nothing in flight is frozen.")) {
      return;
    }
    setResult(null);
    startTransition(async () => {
      const r = await updateMonetarySettingsAction(currentUpdatedAt, {
        monetaryP2pEnabled: enabled,
        monetaryProposalRateLimitWindowSeconds: windowSeconds,
        monetaryProposalRateLimitMaxAttempts: maxAttempts,
        feePercent,
        minStake,
        maxStake,
      });
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) {
          setEnabled(r.settings.monetary.monetaryP2pEnabled);
          setWindowSeconds(r.settings.monetary.monetaryProposalRateLimitWindowSeconds);
          setMaxAttempts(r.settings.monetary.monetaryProposalRateLimitMaxAttempts);
          setFeePercent((r.settings.monetary.p2pFeeBps / 100).toString());
          setMinStake((r.settings.monetary.monetaryP2pMinStakeCents / 100).toFixed(2));
          setMaxStake((r.settings.monetary.monetaryP2pMaxStakeCents / 100).toFixed(2));
        }
      }
    });
  }

  return (
    <SectionCard title="Monetary P2P">
      <FieldRow label="Monetary P2P" description="Master switch for creating new proposals and accepting them. Turning this off blocks NEW commitments only — an already-committed Position always settles normally, and its reservations always resolve. Nothing in flight is ever frozen.">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </FieldRow>
      <FieldRow
        label="Minimum stake"
        htmlFor="monetary-min-stake"
        description={`Currently ${formatCents(initial.monetaryP2pMinStakeCents)}. The smallest amount someone can put on a pick. Applies to new proposals only — one that was already sent keeps the terms it was created with.`}
      >
        <div className="flex items-center gap-1">
          <span className="text-sm text-text-muted" aria-hidden="true">
            $
          </span>
          <Input id="monetary-min-stake" type="text" inputMode="decimal" autoComplete="off" aria-describedby="monetary-min-stake-description" className="w-24" value={minStake} onChange={(e) => setMinStake(e.target.value)} />
        </div>
      </FieldRow>
      <FieldRow
        label="Maximum stake"
        htmlFor="monetary-max-stake"
        description={`Currently ${formatCents(initial.monetaryP2pMaxStakeCents)}. The most someone can put on a pick in one proposal. Nobody can ever stake more than their available balance, whatever this is set to.`}
      >
        <div className="flex items-center gap-1">
          <span className="text-sm text-text-muted" aria-hidden="true">
            $
          </span>
          <Input id="monetary-max-stake" type="text" inputMode="decimal" autoComplete="off" aria-describedby="monetary-max-stake-description" className="w-24" value={maxStake} onChange={(e) => setMaxStake(e.target.value)} />
        </div>
      </FieldRow>
      <FieldRow label="Proposal rate-limit window (seconds)" htmlFor="monetary-rate-window" description="Time window over which the proposal creation attempt cap below applies.">
        <Input id="monetary-rate-window" type="number" aria-describedby="monetary-rate-window-description" className="w-24" value={windowSeconds} onChange={(e) => setWindowSeconds(Number(e.target.value))} />
      </FieldRow>
      <FieldRow label="Proposal rate-limit attempts" htmlFor="monetary-rate-attempts" description="Maximum monetary proposals a single user may create within the window.">
        <Input id="monetary-rate-attempts" type="number" aria-describedby="monetary-rate-attempts-description" className="w-24" value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} />
      </FieldRow>
      <FieldRow
        label="P2P settlement fee"
        htmlFor="monetary-fee-percent"
        description={`Currently ${formatBps(initial.p2pFeeBps)} of the losing stake. Applies only to Positions committed after this change — an already-committed Position keeps the exact rate that was in effect when it was accepted, forever.`}
      >
        <div className="flex items-center gap-1">
          <Input id="monetary-fee-percent" type="number" aria-describedby="monetary-fee-percent-description" className="w-20" value={feePercent} onChange={(e) => setFeePercent(e.target.value)} />
          <span className="text-sm text-text-muted">%</span>
        </div>
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Monetary P2P"}
      </Button>
    </SectionCard>
  );
}

export function ReputationSettingsSection({ initial, updatedAt }: { initial: ReputationSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateReputationSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.reputation);
      }
    });
  }

  return (
    <SectionCard title="Reputation">
      <FieldRow
        label="Leaderboard minimum sample"
        description="Minimum decided (correct + incorrect) graded Picks required to appear in the Prediction Leaderboard. Takes effect immediately; never changes anyone's actual prediction history."
      >
        <Input type="number" className="w-24" value={values.leaderboardMinDecidedPicks} onChange={(e) => setValues((v) => ({ ...v, leaderboardMinDecidedPicks: Number(e.target.value) }))} />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Reputation"}
      </Button>
    </SectionCard>
  );
}

export function OperationsSettingsSection({ initial, updatedAt }: { initial: OperationsSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateOperationsSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.operations);
      }
    });
  }

  return (
    <SectionCard title="Operations">
      <FieldRow label="Settlement batch size" description="Maximum committed Positions the settlement runner processes per invocation. A pure throughput knob — never affects settlement correctness.">
        <Input type="number" className="w-24" value={values.settlementBatchSize} onChange={(e) => setValues((v) => ({ ...v, settlementBatchSize: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Grading batch size" description="Maximum pending Predictions the grading runner processes per invocation. A pure throughput knob — never affects grading correctness.">
        <Input type="number" className="w-24" value={values.gradingBatchSize} onChange={(e) => setValues((v) => ({ ...v, gradingBatchSize: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Challenge resolution batch size" description="Maximum accepted Call BS Challenges the resolution runner processes per invocation. A pure throughput knob — never affects resolution correctness.">
        <Input type="number" className="w-24" value={values.challengeResolutionBatchSize} onChange={(e) => setValues((v) => ({ ...v, challengeResolutionBatchSize: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Job staleness tolerance" description="Multiplier applied to each lifecycle job's own expected cadence before Job Health flags it stale. A pure alerting-sensitivity knob — never affects any job's scheduling or correctness.">
        <Input type="number" className="w-24" value={values.jobStalenessMultiplier} onChange={(e) => setValues((v) => ({ ...v, jobStalenessMultiplier: Number(e.target.value) }))} />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Operations"}
      </Button>
    </SectionCard>
  );
}

export function SponsorshipSettingsSection({ initial, updatedAt }: { initial: SponsorshipSettings; updatedAt: string }) {
  const [values, setValues] = useState(initial);
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt);
  const [result, setResult] = useState<BrohdaSettingsActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const r = await updateSponsorshipSettingsAction(currentUpdatedAt, values);
      setResult(r);
      if (r.settings) {
        setCurrentUpdatedAt(r.settings.updatedAt);
        if (r.conflict) setValues(r.settings.sponsorship);
      }
    });
  }

  return (
    <SectionCard title="Sponsorship">
      <FieldRow label="Sponsored Game Posts" description="Master switch. OFF hides every sponsorship and blocks new sponsor proposals; nothing is deleted. Turning it back ON shows only sponsorships that are still paid, approved and inside their campaign window.">
        <Switch aria-label="Sponsored Game Posts" checked={values.sponsorshipEnabled} onCheckedChange={(checked) => setValues((v) => ({ ...v, sponsorshipEnabled: checked }))} />
      </FieldRow>
      <FieldRow label="Default currency" description="3-letter code pre-filled on new inventory (each inventory row and sponsorship keeps its own).">
        <Input className="w-24 uppercase" maxLength={3} value={values.sponsorshipDefaultCurrency} onChange={(e) => setValues((v) => ({ ...v, sponsorshipDefaultCurrency: e.target.value }))} />
      </FieldRow>
      <FieldRow label="Logo max size (bytes)" description="Largest sponsor logo accepted on upload.">
        <Input type="number" className="w-32" value={values.sponsorshipLogoMaxBytes} onChange={(e) => setValues((v) => ({ ...v, sponsorshipLogoMaxBytes: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Default campaign end (hours after kickoff)" description="Pre-fills a new inventory item's window.">
        <Input type="number" className="w-24" value={values.sponsorshipEndAfterKickoffHours} onChange={(e) => setValues((v) => ({ ...v, sponsorshipEndAfterKickoffHours: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Unpaid hold (hours)" description="A submitted, unpaid sponsorship holds its Game this long, then is released. 0 = never.">
        <Input type="number" className="w-24" value={values.sponsorshipReservationHours} onChange={(e) => setValues((v) => ({ ...v, sponsorshipReservationHours: Number(e.target.value) }))} />
      </FieldRow>
      <FieldRow label="Payment instructions" description="Shown to a sponsor after they submit. Never put secrets here.">
        <textarea
          className="min-h-24 w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary"
          maxLength={2000}
          value={values.sponsorshipPaymentInstructions}
          onChange={(e) => setValues((v) => ({ ...v, sponsorshipPaymentInstructions: e.target.value }))}
        />
      </FieldRow>
      <SectionFeedback result={result} />
      <Button type="button" disabled={isPending} onClick={save}>
        {isPending ? "Saving…" : "Save Sponsorship"}
      </Button>
    </SectionCard>
  );
}
