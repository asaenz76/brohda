// Brohda 2.1 M7 — the activation and return funnel as the Super Admin report sees it. Aggregates only (counts, one median, per-week cohort counts); see migration 220.

export interface ActivationWeek {
  /** The Monday (Costa Rica week) the cohort registered in, YYYY-MM-DD. */
  week: string;
  registered: number;
  /** Of those, how many registered at least 24 hours ago (the only ones who have had a full day to pick). */
  registered24hOld: number;
  /** Of those 24-hour-old Members, how many made a first Pick within 24 hours of registering. */
  pickedWithin24h: number;
}

export interface ActivationFunnel {
  from: string;
  to: string;
  registered: number;
  registered24hOld: number;
  pickedEver: number;
  /** Members registered at least 24 hours ago who made a first Pick within 24 hours of registering (so never more than registered24hOld). */
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
