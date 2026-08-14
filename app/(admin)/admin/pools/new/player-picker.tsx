"use client";

import { useEffect, useMemo, useState } from "react";
import { getTeamSquadAction, type SquadPlayer } from "@/lib/actions/squads";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PlayerPickerProps {
  homeTeamExternalId: string | null;
  homeTeamName: string;
  awayTeamExternalId: string | null;
  awayTeamName: string;
  // Which provider these team ids belong to — threaded through to
  // getTeamSquadAction so the squad lookup routes by the fixture's own
  // identity rather than assuming football (Phase 3 spec §1). Optional
  // only because getTeamSquadAction itself defaults to football for any
  // caller that predates this prop; PLAYER_TO_SCORE is football-only
  // today, so every real caller already has a football fixture.provider
  // to pass.
  provider?: string;
  selectedPlayerId: string;
  selectedPlayerName: string;
  onSelect: (player: { externalPlayerId: string; name: string }) => void;
}

/**
 * Mirrors CommentSheet.tsx's exact fetch convention — a plain read-only
 * server action called from useEffect, `null` sentinel for "not loaded
 * yet," no per-keystroke network call (the fetched squad is small enough
 * to filter client-side, same spirit as LeagueSelect's in-memory grouping).
 */
export function PlayerPicker({
  homeTeamExternalId,
  homeTeamName,
  awayTeamExternalId,
  awayTeamName,
  provider,
  selectedPlayerId,
  selectedPlayerName,
  onSelect,
}: PlayerPickerProps) {
  // `forId` lets `loading` be derived (current id vs. the id the cached
  // squad was fetched for) instead of resetting state synchronously inside
  // the effect body, which react-hooks/set-state-in-effect disallows.
  const [homeSquad, setHomeSquad] = useState<{ forId: string | null; players: SquadPlayer[] } | null>(null);
  const [awaySquad, setAwaySquad] = useState<{ forId: string | null; players: SquadPlayer[] } | null>(null);
  const [search, setSearch] = useState("");

  // getTeamSquadAction itself no longer throws (Phase 3 fix — it falls
  // back to cache on any provider failure), but a `.catch` stays here as
  // defense-in-depth against a transport-level Server Action rejection,
  // so `loading` always resolves either way instead of spinning forever
  // on the one failure mode that isn't inside the action's own control.
  useEffect(() => {
    const id = homeTeamExternalId;
    (id ? getTeamSquadAction(id, provider) : Promise.resolve<SquadPlayer[]>([]))
      .then((players) => setHomeSquad({ forId: id, players }))
      .catch(() => setHomeSquad({ forId: id, players: [] }));
  }, [homeTeamExternalId, provider]);

  useEffect(() => {
    const id = awayTeamExternalId;
    (id ? getTeamSquadAction(id, provider) : Promise.resolve<SquadPlayer[]>([]))
      .then((players) => setAwaySquad({ forId: id, players }))
      .catch(() => setAwaySquad({ forId: id, players: [] }));
  }, [awayTeamExternalId, provider]);

  const loading = homeSquad?.forId !== homeTeamExternalId || awaySquad?.forId !== awayTeamExternalId;

  const filteredHome = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = homeSquad?.players ?? [];
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  }, [homeSquad, search]);
  const filteredAway = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = awaySquad?.players ?? [];
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  }, [awaySquad, search]);

  if (selectedPlayerId && selectedPlayerName) {
    return (
      <div className="space-y-1.5">
        <Label>Player</Label>
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle p-2">
          <span className="flex-1 text-sm text-text-primary">{selectedPlayerName}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => onSelect({ externalPlayerId: "", name: "" })}>
            Change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="player-search">Player</Label>
      <Input
        id="player-search"
        placeholder="Search player name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {loading ? (
        <p className="text-sm text-text-muted">Loading squads…</p>
      ) : (
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border-subtle p-2">
          {[
            { label: homeTeamName, players: filteredHome },
            { label: awayTeamName, players: filteredAway },
          ].map((group) => (
            <div key={group.label}>
              <p className="px-1 text-xs font-medium text-text-muted">{group.label}</p>
              {group.players.length === 0 && (
                <p className="px-1 py-1 text-xs text-text-muted">No players found.</p>
              )}
              {group.players.map((player) => (
                <button
                  key={player.externalPlayerId}
                  type="button"
                  onClick={() => onSelect({ externalPlayerId: player.externalPlayerId, name: player.name })}
                  className={cn(
                    "block w-full rounded-md px-2 py-1.5 text-left text-sm text-text-secondary hover:bg-surface-secondary",
                  )}
                >
                  {player.name}
                  {player.position && <span className="text-text-muted"> — {player.position}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
