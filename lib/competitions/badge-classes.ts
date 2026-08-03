// Shared Tailwind classes for the two status badges — used by both the
// list UI (competition-manager.tsx) and the Workspace layout, so the two
// surfaces never visually disagree about what a status means.
export const IMPORT_STATUS_BADGE_CLASS: Record<string, string> = {
  NOT_IMPORTED: "bg-surface-secondary text-text-muted",
  IMPORTING: "bg-warning-muted/20 text-warning-muted",
  IMPORTED: "bg-credit/20 text-credit",
  IMPORT_FAILED: "bg-destructive/20 text-destructive",
};

export const OPERATIONAL_STATUS_BADGE_CLASS: Record<string, string> = {
  ACTIVE: "bg-credit/20 text-credit",
  PREPARED: "bg-surface-secondary text-text-secondary",
  NO_UPCOMING_FIXTURES: "bg-surface-secondary text-text-muted",
  COMPLETED: "bg-surface-secondary text-text-muted",
  ARCHIVED: "bg-surface-secondary text-text-muted",
  NEEDS_ATTENTION: "bg-warning-muted/20 text-warning-muted",
};
