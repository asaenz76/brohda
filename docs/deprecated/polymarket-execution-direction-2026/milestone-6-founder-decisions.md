# Milestone 6 Founder Decisions

> **DEPRECATED (2026-09-21).** This document describes the abandoned Polymarket / real-money-execution product direction. It is historical only — see `docs/deprecated/polymarket-execution-direction-2026/README.md` and `docs/architecture/sports-prediction-network.md` for Brohda's current, sports-only direction. Nothing below reflects the active product.


**Status**: A sign-off form, not a decision. Every box below is **unchecked** because no founder has reviewed or approved anything in this document — it is produced by an engineering readiness task, not a substitute for founder judgment. See [`docs/architecture/milestone-6-readiness.md`](./milestone-6-readiness.md) for the full reasoning behind each recommendation, and [`docs/legal/milestone-6-counsel-brief.md`](../legal/milestone-6-counsel-brief.md) for the questions that require counsel before several of these can be finalized even after founder approval.

**How to use this document**: check a box only after the founder has actually made that decision. An unchecked box is the true, honest state — it is not a placeholder to be filled in mechanically. Several decisions below are explicitly "subject to counsel," meaning founder approval alone does not unblock Milestone 6 for that item; both this document and the legal sign-off checklist must reflect approval before that item is closed (see the readiness doc's decision matrix, §6, "Authority required" column).

---

## Product / custody

- [ ] Brohda will not custody user funds
- [ ] User owns the wallet (Deposit Wallet model)
- [ ] Delegated Session Key model approved (subject to counsel — see counsel brief Q2)
- [ ] Minimal crypto-visible UX approved (no wallet address, chain name, token balance, "Polygon," or signing language shown to consumers by default)

**Preferred technical architecture** (readiness doc §6, gate doc §7): Brohda does not custody funds; the user owns a Deposit Wallet; Brohda holds only a scoped, revocable, non-withdrawal-capable Session Key; the consumer never sees crypto mechanics. **None of this is approved until the founder checks the boxes above — a technical recommendation is not a decision.**

Founder notes (reasoning, exceptions, or conditions attached to approval — leave blank if none):

```


```

---

## Geography

- [ ] Initial target jurisdiction(s) selected for counsel review

**Jurisdiction(s) selected** (list every jurisdiction the founder wants counsel to review — this document does not infer, suggest, or default to any jurisdiction, including Brohda's current operating base):

```


```

**Note**: A jurisdiction being selected here does not mean it is approved. It becomes a candidate row in the jurisdiction-eligibility structure defined in the readiness doc (§8), gated further by (a) whether Polymarket itself currently permits trading there (readiness doc §3 — re-verify at launch time, the list changes) and (b) counsel's own review (`milestone-6-legal-signoff.md`).

---

## Monetization

- [ ] Brohda fee philosophy selected
- [ ] Fee disclosure principle approved

**Fee philosophy** (select the founder's actual choice — this document does not choose one):

- [ ] No Brohda fee at launch (builder-fee revenue only, or zero revenue)
- [ ] Brohda platform fee, structured as: _______________________
- [ ] Other model: _______________________

**Builder fee actual rate** (within Polymarket's provider-confirmed cap of 0–100 bps taker / 0–50 bps maker, readiness doc §3): _______________________ (leave blank if not yet decided — a blank here does not block Milestone 6 coding per the readiness doc's coding-vs-launch-blocker split, §7)

Founder notes:

```


```

---

## Rollout

- [ ] Initial rollout strategy selected

**Strategy** (select one; the mechanism itself must support changing this without a deployment, per the readiness doc §19 — this checkbox records the founder's chosen *starting point*, not a permanent architectural constraint):

- [ ] Founder-only
- [ ] Internal team
- [ ] Explicit allowlist
- [ ] Invited beta users
- [ ] Percentage rollout
- [ ] Other: _______________________

Founder notes:

```


```

---

## Legacy wallet

- [ ] Separation / wind-down / migration direction selected

**Direction** (select one — see readiness doc §15 for the full definition of each option; option C requires legal/accounting review before it may be selected, per this task's own explicit instruction, and is not pre-approved by checking this box alone):

- [ ] A — Permanent separation (already the architecturally locked default; no new work required to keep this true)
- [ ] B — Controlled wind-down (legacy wallet resolved before real execution launches)
- [ ] C — Migration/credit conversion (requires separate legal/accounting review before this box may be checked)

Founder notes:

```


```

---

## Risk

- [ ] Founder accepts the preferred architecture's risk profile, subject to counsel

This is **not** a substitute for legal review — it records that the founder has read and understood the technical risk tradeoffs in [`docs/architecture/execution-architecture-gate.md`](./execution-architecture-gate.md) (Option comparison, §6/§28) and [`docs/security/execution-threat-model.md`](../security/execution-threat-model.md) (asset/threat inventory), and accepts them as a starting point for counsel's own independent review — not that counsel has cleared anything.

Founder notes:

```


```

---

## Sign-off

| Field | Value |
|---|---|
| Founder name | _______________________ |
| Date | _______________________ |
| Version of `milestone-6-readiness.md` reviewed | _______________________ |

**No box on this page was checked by the engineering task that produced this document.** Every checkbox above is a genuine open question awaiting the founder's own review.
