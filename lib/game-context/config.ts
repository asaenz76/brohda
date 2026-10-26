import type { GameContextConfig } from "./types";

// Brohda 2.1 M3 — Game Context policy. Pure parsing, fail-closed: anything that is not a complete, in-range policy means Game Context is OFF (never a half-valid one).
// Stored as `platform_settings.game_context_enabled` (boolean, default false) plus `platform_settings.game_context_config` (jsonb, snake_case keys, every key optional).
// The database function admin_set_game_context_policy enforces the same keys and ranges; this parser is the second line.

export const GAME_CONTEXT_DEFAULTS: Readonly<Omit<GameContextConfig, "enabled">> = {
  minWinStreak: 3,
  minLossStreak: 3,
  minVenueStreak: 3,
  lastN: 5,
  lastNMinDecisive: 4,
  seriesEnabled: true,
  pairsEnabled: true,
  connectiveEnabled: true,
  minScore: 30,
  maxChars: 140,
};

export const DISABLED_GAME_CONTEXT: GameContextConfig = { enabled: false, ...GAME_CONTEXT_DEFAULTS };

type Field = { key: string; prop: keyof typeof GAME_CONTEXT_DEFAULTS; kind: "int"; min: number; max: number } | { key: string; prop: keyof typeof GAME_CONTEXT_DEFAULTS; kind: "bool" };

/** One table drives the parser, the Super Admin form and the tests, so the three cannot drift. */
export const GAME_CONTEXT_FIELDS: readonly Field[] = [
  { key: "min_win_streak", prop: "minWinStreak", kind: "int", min: 2, max: 20 },
  { key: "min_loss_streak", prop: "minLossStreak", kind: "int", min: 2, max: 20 },
  { key: "min_venue_streak", prop: "minVenueStreak", kind: "int", min: 2, max: 20 },
  { key: "last_n", prop: "lastN", kind: "int", min: 3, max: 20 },
  { key: "last_n_min_decisive", prop: "lastNMinDecisive", kind: "int", min: 2, max: 20 },
  { key: "series_enabled", prop: "seriesEnabled", kind: "bool" },
  { key: "pairs_enabled", prop: "pairsEnabled", kind: "bool" },
  { key: "connective_enabled", prop: "connectiveEnabled", kind: "bool" },
  { key: "min_score", prop: "minScore", kind: "int", min: 10, max: 200 },
  { key: "max_chars", prop: "maxChars", kind: "int", min: 40, max: 200 },
];

export function parseGameContextConfig(row: { game_context_enabled?: unknown; game_context_config?: unknown } | null | undefined): GameContextConfig {
  if (!row || row.game_context_enabled !== true) return DISABLED_GAME_CONTEXT;
  const raw = row.game_context_config;
  if (raw === null || raw === undefined) return { enabled: true, ...GAME_CONTEXT_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) return DISABLED_GAME_CONTEXT;
  const source = raw as Record<string, unknown>;
  const out: Record<string, number | boolean> = { ...GAME_CONTEXT_DEFAULTS };
  for (const field of GAME_CONTEXT_FIELDS) {
    const value = source[field.key];
    if (value === undefined) continue;
    if (field.kind === "bool") {
      if (typeof value !== "boolean") return DISABLED_GAME_CONTEXT;
      out[field.prop] = value;
    } else {
      if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) return DISABLED_GAME_CONTEXT;
      out[field.prop] = value;
    }
  }
  const config = { enabled: true, ...out } as GameContextConfig;
  // "At least N-of-N decisive" cannot exceed the window, and must be a real majority of it, or "notable" means nothing.
  if (config.lastNMinDecisive > config.lastN || config.lastNMinDecisive * 2 <= config.lastN) return DISABLED_GAME_CONTEXT;
  return config;
}
