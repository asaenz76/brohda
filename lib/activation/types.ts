// Brohda 2.1 M7 — the activation and return funnel as the Super Admin report sees it. Aggregates only (counts, one median, per-week cohort counts); see migration 220.

export interface ActivationWeek {
  /** The Monday (Costa Rica week) the cohort registered in, YYYY-MM-DD. */
  week: string;
  registered: number;
  pickedWithin24h: number;
}

export interface ActivationFunnel {
  from: string;
  to: string;
  registered: number;
  registered24hOld: number;
  pickedEver: number;
  pickedWithin24h: number;
  medianMinutesToFirstPick: number | null;
  activated7dOld: number;
  secondPickWithin7d: number;
  firstGraded48hOld: number;
  cameBackWithin48h: number;
  commented: number;
  calledBs: number;
  weeklyMinDecided: number;
  rankedThisWeek: number;
  byWeek: ActivationWeek[];
}
