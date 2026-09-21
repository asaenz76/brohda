# Milestone 6 Counsel Brief — Real Order Execution

**This document is not legal advice. It contains no legal conclusions.** It is a briefing prepared by an engineering readiness task to give qualified counsel the product and technical context needed to answer the questions in §3. See [`docs/architecture/milestone-6-readiness.md`](../architecture/milestone-6-readiness.md) for the full engineering readiness package this brief supports, and [`docs/legal/milestone-6-legal-signoff.md`](./milestone-6-legal-signoff.md) for the checklist counsel completes once these questions are answered.

---

## 1. Product summary

**Brohda** is a consumer prediction-network product. Today, live in production:

- **Discovery**: users browse real, currently-active prediction markets sourced from a third-party provider (Polymarket), see live YES/NO probabilities, and can filter by category. No money is involved; this is read-only market data.
- **Predictions**: a user can record a free, permanent belief ("I predict YES on this market") against a real market's current price. This creates no financial exposure whatsoever — no amount is entered, no money moves, and the record exists purely to track prediction accuracy over time (a social/reputation feature, not a financial one).
- **Simulated execution** (most recently shipped): a user can walk through a full "what if I actually did this" flow — choose YES/NO, enter a dollar amount, receive a computed price quote based on the provider's real, live order-book data, see an estimated return and estimated fees, and confirm. This produces a permanent record that is **structurally marked as simulated at the database level** — no wallet is created, no signature is produced, no money moves, and no request is ever sent to the provider's order-placement systems. It exists to validate the product experience and the underlying pricing math before any real money is involved.

**Proposed (not yet built, and the subject of this brief)**: **real order execution** — letting a small, controlled group of users convert a Prediction into an actual financial position by placing a real order against the same third-party provider (Polymarket), for real money.

**The proposed technical model, in plain terms** (this is Brohda's own engineering *recommendation*, not yet approved by Brohda's founder and explicitly contingent on counsel's answers below):

- **User-owned wallet concept**: the user would hold their own cryptocurrency wallet with the provider (a "Deposit Wallet," in the provider's own terminology) — Brohda would never hold the user's funds directly, would never be handed the wallet's primary private key, and would not act as a deposit intermediary. The user funds this wallet directly (mechanics not yet finalized), and later withdraws directly from it — Brohda is not a party to either action under this model.
- **Delegated Session Key concept**: to let Brohda's software place orders on the user's behalf without the user manually signing every single trade, the provider offers a native mechanism (a "Session Key") that the user explicitly authorizes, time-limited (currently up to 180 days per the provider's own current terms), scoped only to placing/cancelling orders. **Critically, the provider's own documentation states this key type cannot be used to withdraw funds from the wallet under any circumstance**, even if the key itself were stolen. Brohda's servers would hold this delegated key (a real secret, requiring real protection) but never the user's primary wallet key.
- **Builder integration**: the provider has a program for third-party applications like Brohda to register, receive a small share of trading fees on orders they route, and be attributed on-chain for those orders. This is a standard, documented mechanism, not a novel integration.
- **Brohda fee concept**: whether and how Brohda charges a fee beyond (or instead of) the above builder-fee mechanism is an open founder decision, not yet made, and is one of the questions this brief asks counsel to weigh in on (§3, Q3).
- **No intended custody under the preferred architecture**: at no point in the proposed model does Brohda hold, control, or have withdrawal access to a user's funds. The only asset Brohda would hold is the delegated, non-withdrawal-capable Session Key described above.

---

## 2. Proposed money flow

```
User's own money
        ↓
User-controlled wallet (held with the third-party provider, not with Brohda)
        ↓
Provider execution (the actual trade happens on the provider's own systems,
                     using Brohda's delegated, order-only Session Key)
        ↓
Result reflected back to the user through Brohda's interface
        (Brohda reads and displays the outcome; Brohda never holds the money)
```

**Under the preferred architecture, Brohda is never shown holding funds at any point in this diagram.** The only thing that ever passes through anything Brohda controls is (a) the request to place an order and (b) the delegated authority (the Session Key) to sign it — never the money itself, and never a signature capable of moving money out of the wallet.

This is explicitly a *proposal*, not a locked design. Counsel's answers below may require a different money-flow diagram entirely (e.g. if delegated signing is found to constitute custody or agency in a way that changes the recommended architecture, or if a different jurisdiction's requirements demand a materially different flow).

---

## 3. Questions for counsel

For each question: **why it matters**, **what technical architecture depends on it**, **what answer would unblock** further work, and **what answer would force a redesign**.

### Q1. Legal classification of Brohda's role

**Why it matters**: Nearly every other question below depends on how Brohda's role is characterized — introducer, agent, broker, intermediary platform operator, or something else entirely — under applicable law.

**What technical architecture depends on it**: The entire eligibility/compliance pipeline (readiness doc §10), the disclosures Brohda must show users, and whether Brohda needs any license or registration at all.

**What answer would unblock**: A clear classification lets engineering finalize the real eligibility-gate architecture (readiness doc §10) and the disclosure copy requirements with confidence.

**What answer would force redesign**: A classification requiring licensing Brohda does not currently hold would block real execution entirely until that licensing is obtained — a business/timeline decision, not a technical one.

### Q2. Does delegated signing (the Session Key model) constitute custody, agency, or control?

**Why it matters**: This is the single most architecture-defining legal question. The provider's own guarantee that a Session Key cannot withdraw funds is a technical fact, not a legal conclusion about whether *holding* that key — even non-withdrawal-capable — creates a fiduciary, agency, or custodial relationship between Brohda and the user.

**What technical architecture depends on it**: The entire "Option C" recommendation in the engineering readiness package (delegated Session Key on a user-owned wallet) — this is Brohda's stated technical preference, but it is explicitly **not** cleared for use pending this answer.

**What answer would unblock**: Confirmation that this model does not create custody/agency obligations (or does so in a way Brohda can readily satisfy) would let Milestone 6 proceed on the recommended architecture.

**What answer would force redesign**: If delegated signing is found to constitute custody or agency in a way Brohda cannot readily satisfy, engineering would need to fall back to a fully user-signed model (no Brohda-held key at all, meaningfully worse UX) or a different embedded-wallet vendor architecture, each with its own follow-on legal questions.

### Q3. Do Builder fees change Brohda's regulatory role?

**Why it matters**: Earning a share of transaction-based revenue (as opposed to, e.g., a flat subscription unrelated to trading activity) may itself affect how Brohda is characterized under Q1's classification.

**What technical architecture depends on it**: Whether Brohda may register as a Polymarket Builder at all before this question is resolved (the technical registration itself requires no approval from Polymarket, per the readiness doc's provider research, but that is a provider fact, not a legal clearance).

**What answer would unblock**: A "no material change" answer lets Brohda proceed with builder-fee registration and, separately, its own founder-chosen fee philosophy (readiness doc §16).

**What answer would force redesign**: A "yes, this changes your role" answer might require restructuring the fee model entirely (e.g. no per-transaction fee at all, a different revenue model) before real execution can launch.

### Q4. May Brohda serve users in the founder's proposed target jurisdiction(s)?

**Why it matters**: This is a distinct question from whether Polymarket itself permits trading in a given jurisdiction (Polymarket's own current restricted-jurisdiction list — 39 named countries plus specific sub-national regions — was independently re-verified as part of this readiness task and is recorded in the readiness doc §3/§8, but a jurisdiction Polymarket permits is not evidence Brohda may operate there, and vice versa).

**What technical architecture depends on it**: The entire geography-enforcement pipeline (readiness doc §8/§10) — which jurisdictions get a `launch_approved = true` row at all.

**What answer would unblock**: Approval of at least one jurisdiction lets Milestone 6 scope its first real launch cohort geographically.

**What answer would force redesign**: A rejection of the founder's initially proposed jurisdiction(s) — including, explicitly, Brohda's current operating base, which this brief does not assume is automatically acceptable — would require the founder to select different candidates before launch scoping can proceed (see the founder decision form).

### Q5. Geofencing obligations

**Why it matters**: Once at least one jurisdiction is approved, counsel must specify what enforcement standard is actually required (IP geolocation only, IP plus some attestation, IP plus full KYC-verified residency) — this varies significantly by jurisdiction and regulatory theory.

**What technical architecture depends on it**: The specific signals the geography-enforcement pipeline must collect and check (readiness doc §8/§10) and whether a geolocation vendor is needed at all.

**What answer would unblock**: A specified standard lets engineering build (or select a vendor for) the actual enforcement mechanism.

**What answer would force redesign**: A stricter-than-expected standard (e.g. requiring full KYC-verified residency even for jurisdictions with otherwise-permissive Polymarket status) would significantly expand the KYC/AML scope (Q6/Q7) beyond what might otherwise be needed.

### Q6. KYC obligations

**Why it matters**: Determines whether Brohda must independently verify user identity, distinct from anything Polymarket itself may or may not do (Polymarket's own KYC posture for ordinary traders was not confirmed by this readiness task's provider research — the fetched documentation pages did not address it).

**What technical architecture depends on it**: The full KYC capability list in the readiness doc §11 (identity verification, document verification, a review queue, etc.) — none of which is built today.

**What answer would unblock**: A clear responsibility assignment (provider handles / Brohda handles / shared / not required) lets engineering scope exactly how much of §11's capability list is actually needed.

**What answer would force redesign**: "Brohda handles" would require a net-new vendor integration and review-queue workflow before launch; "not required" would let Milestone 6 proceed without one.

### Q7. AML obligations

**Why it matters**: Distinct from KYC — concerns ongoing monitoring for suspicious activity patterns, not just onboarding identity verification.

**What technical architecture depends on it**: Whether a transaction-monitoring/reporting capability needs to exist at all, and if so, its shape (real-time vs. batch, thresholds, escalation path).

**What answer would unblock**: A clear scope lets engineering decide whether this is a Milestone 6 launch requirement or a later addition.

**What answer would force redesign**: A requirement for real-time AML monitoring would need to be designed into the order-submission path itself, not bolted on afterward.

### Q8. Sanctions-screening obligations

**Why it matters**: Brohda's own OFAC-or-equivalent screening obligations, independent of whatever screening Polymarket itself performs (not confirmed either way by this readiness task's provider research).

**What technical architecture depends on it**: Whether a sanctions-screening step belongs in the eligibility pipeline (readiness doc §10) at all, and whether it requires a vendor (readiness doc §9).

**What answer would unblock**: A clear responsibility assignment, same shape as Q6.

**What answer would force redesign**: Same as Q6 — a Brohda-responsibility answer requires a net-new vendor integration.

### Q9. Age requirements

**Why it matters**: Minimum age for real-money participation, and how it must be verified, likely varies by jurisdiction and by the product's ultimate legal classification (Q1).

**What technical architecture depends on it**: Whether age verification is a simple self-attestation or requires document-based verification (which would fold into the KYC capability list, §11).

**What answer would unblock**: A specified age and verification standard lets engineering build the actual gate.

**What answer would force redesign**: A document-verification requirement would add real KYC-adjacent infrastructure that a self-attestation model would not need.

### Q10. Consumer disclosures

**Why it matters**: What Brohda's own Terms of Service and in-product copy must disclose about the relationship to Polymarket, the fee structure, and the risk of loss.

**What technical architecture depends on it**: The already-architecturally-locked requirement (readiness doc §16, gate doc §13/§22) that total estimated cost be shown before confirmation — counsel's answer may require *additional* disclosure content beyond cost (e.g. a risk-of-loss statement, a "you are trading on a third-party platform" statement), but does not change the *mechanism* (a pre-confirmation disclosure screen already exists in the simulated flow and is designed to be extended, not rebuilt).

**What answer would unblock**: Specific required disclosure language lets engineering/product finalize the confirmation-screen copy.

**What answer would force redesign**: A disclosure requirement significantly longer or more complex than a single confirmation screen could reasonably hold might require a separate acknowledgment/consent flow.

### Q11. Record-retention requirements

**Why it matters**: How long Brohda must retain financial/compliance records, and in what form.

**What technical architecture depends on it**: Whether the existing "permanent, never-deleted" pattern already used for Predictions (a locked product principle, roadmap §9 item 11) is sufficient for real-execution records, or whether additional retention/export/audit requirements apply.

**What answer would unblock**: A specified retention period/format lets engineering confirm the existing audit-logging design (readiness doc §23, gate doc §21) meets it.

**What answer would force redesign**: A requirement for a specific export format, encryption standard, or retention period materially different from "keep forever in the primary database" would require new tooling.

### Q12. Tax/reporting obligations

**Why it matters**: Whether Brohda must issue consumer tax documents or meet reporting thresholds in its operating jurisdiction(s).

**What technical architecture depends on it**: Whether a tax-document-generation capability needs to exist at all — not built today, not scoped in the current technical implementation checklist (readiness doc §26) beyond this brief surfacing it.

**What answer would unblock**: "Not required at launch scale" lets Milestone 6 proceed without this capability.

**What answer would force redesign**: A reporting requirement would need its own dedicated design effort, likely gating launch until built.

### Q13. Complaint/dispute obligations

**Why it matters**: Whether a specific regulatory-minimum dispute-handling process is required, distinct from Brohda's own product-support process design (readiness doc §26, a founder/engineering decision for the non-regulatory-minimum parts).

**What technical architecture depends on it**: Whether the support-case handling table in the readiness doc (§26) needs a formal, counsel-specified escalation path added.

**What answer would unblock**: Confirmation that Brohda's own reasonable support process (already scoped) meets any regulatory minimum.

**What answer would force redesign**: A formal regulatory dispute process (e.g. a specific arbitration clause, a specific response-time requirement) would need to be built into both the Terms of Service and the actual support workflow.

### Q14. Privacy / data-transfer implications

**Why it matters**: Collecting geolocation and/or KYC data (if required by Q5/Q6) may trigger cross-border data-transfer obligations, especially if any vendor used for KYC/sanctions screening is based in a different jurisdiction than the user or than Brohda.

**What technical architecture depends on it**: Vendor selection for KYC/sanctions screening (readiness doc §9) may need to be constrained by data-residency requirements counsel identifies.

**What answer would unblock**: A clear set of constraints lets engineering evaluate vendors against them directly.

**What answer would force redesign**: A strict data-residency requirement could eliminate otherwise-preferred vendors from consideration.

### Q15. Do user-owned wallets materially change compliance treatment?

**Why it matters**: This is, in effect, a synthesis question — does the fact that Brohda never custodies funds (under the preferred architecture) meaningfully reduce Brohda's regulatory burden compared to a custodial model, or does the delegated-signing relationship (Q2) largely erase that benefit?

**What technical architecture depends on it**: Whether the "no custody" framing this entire technical recommendation is built around actually delivers the regulatory-lightness it is designed for.

**What answer would unblock**: Confirmation that non-custody meaningfully reduces the compliance burden validates the entire technical direction (gate doc §7's recommendation).

**What answer would force redesign**: If counsel determines the delegated-signing relationship effectively erases the non-custody benefit, the entire architecture comparison (gate doc §6/§28 — Options A through D) should be revisited with counsel's input on which option genuinely minimizes regulatory burden, not just which one is most technically elegant.

---

**No legal conclusion is offered anywhere in this document.** Every "what answer would unblock / force redesign" note above describes an engineering consequence, not a prediction of what counsel will say.
