# Execution Threat Model — Milestone 4

**Status**: Companion to `docs/architecture/execution-architecture-gate.md` (Milestone 4 — Execution Architecture Gate). This is a threat model for a **future, not-yet-implemented** execution capability, evaluated against the recommended architecture (Option C — Session-Key delegated signing, `execution-architecture-gate.md` §7). **No execution code exists in this codebase as of this document.** Mitigations described below as "existing" refer to patterns already proven elsewhere in this codebase for other features (Prediction, discovery, legacy wallet) that a future execution implementation should reuse — they are not yet applied to execution because execution does not yet exist. This distinction is maintained explicitly throughout: **no mitigation is claimed to exist for execution itself unless execution code exists, which it does not.**

---

## 1. Assets

| Asset | Description | Exists today? |
|---|---|---|
| User's Polymarket Deposit Wallet funds | The actual collateral asset (§1 of the gate doc — "pUSD"/USDC, unconfirmed which) held in the user's own wallet | No Brohda code touches this today |
| Session Key material (future) | A per-user, scoped, time-limited signer credential, if Option C is approved | Does not exist |
| Builder registration credentials (future) | Whatever secret/identifier Brohda would use to register as a Polymarket Builder and receive fee payouts | Does not exist |
| Brohda's own Prediction history | Permanent belief records (Milestone 3) | **Exists today** — must never be put at risk by execution work |
| Legacy wallet ledger (`wallet_balances`/`wallet_transactions`) | Brohda's own internal pari-mutuel accounting | **Exists today** — must remain isolated from execution (gate doc §25/§26) |
| User PII potentially collected for KYC/geofencing (future) | Identity documents, geolocation data | Does not exist |
| Audit/observability data (future execution events) | Correlation IDs, event logs | Does not exist |

## 2. Trust boundaries

```
[ Untrusted: browser / client ]
        |  (HTTPS, session cookie)
[ Trusted: Brohda Next.js server — Server Actions / Route Handlers ]
        |  (service-role Supabase client; future: Session Key material)
[ Trusted, higher sensitivity: Brohda's secrets store (env vars / hosting secret manager) ]
        |  (network calls, signed requests)
[ External, semi-trusted: Polymarket CLOB / Relayer / Builder Service ]
        |
[ External, untrusted from Brohda's perspective: the Polygon network itself ]
```

Every boundary crossing above already exists in some form in this codebase (client→server, server→Supabase) except the two lowest layers, which are entirely new to a future execution feature. **The highest-risk new boundary is server→Polymarket with Session Key material in the path** — this did not exist before this milestone's research and is the primary subject of this document.

## 3. Threat actors

| Actor | Motivation | Capability |
|---|---|---|
| External attacker (internet-facing) | Financial theft, fraud | Standard web attack surface: XSS, CSRF, credential stuffing, replay |
| Compromised user session | Account takeover | Whatever the legitimate user could do — place/cancel orders within that user's own Session Key scope |
| Malicious or compromised admin | Insider fraud, unauthorized override | Whatever admin tooling exposes — per this milestone's own instruction, this must remain narrowly scoped (diagnostics over mutation, exactly the precedent already set for Prediction admin tooling, `app/(admin)/admin/predictions/page.tsx`) |
| Supply-chain attacker | Inject malicious code via a dependency | Whatever the compromised package's install/runtime scope allows — highest risk if it touches signing code |
| Compromised developer machine | Leak secrets, push malicious code | Depends entirely on what secrets/access that developer holds locally |
| Provider-side compromise (Polymarket itself) | Outside Brohda's control | Brohda can only design for resilience (circuit breakers, reconciliation), not prevent this |

## 4. Secrets inventory and blast radius (per the recommended architecture)

| Secret | Where it would live | Who/what can access it | What compromise allows | Blast radius | Rotation/revocation | Recovery |
|---|---|---|---|---|---|---|
| Per-user Session Key | Server-side secret store, keyed per user (exact mechanism not yet designed — gate doc §20) | Only the specific server-side code path that submits orders for that user | Place/cancel orders within the key's scope (`CLOB` only, recommended) for that one user, until revoked | **Bounded — cannot withdraw funds** (provider-enforced guarantee, gate doc §2.3). Limited to one user's trading activity, not the whole platform. | Provider-native: the Deposit Wallet owner (the user) can revoke at any time; Brohda-initiated revocation would also need to be possible (e.g. on suspected compromise) | User re-authorizes a new Session Key; no Brohda-side recovery burden |
| Builder registration credential/identifier | Server-side secret store | Whatever backend code submits orders with the `builder` field set | Could allow an attacker to submit orders attributed to Brohda's builder code (reputational/fee-diversion risk), or to alter Brohda's registered fee rate if the credential also grants profile-management access | Platform-wide (affects Brohda's builder identity, not directly individual user funds) | Provider-native builder-profile management (not yet researched in detail — flagged as an open item for whoever implements this) | Re-register / rotate via Polymarket's own builder tooling |
| Any provider API key used server-side for read-only market data (already exists conceptually via Milestone 1's `PREDICTION_MARKETS_POLYMARKET_ENABLED` gate, though the Gamma API itself requires no key today per Milestone 1's own research) | Environment variable, if one is ever needed | Server-only code (`server-only` package discipline already enforced throughout `lib/prediction-markets/`) | Limited — read-only market data has no direct financial blast radius | Low | Standard env-var rotation | N/A |
| **What Brohda must never hold**: a user's primary Deposit Wallet private key | N/A — explicitly not part of the recommended architecture | N/A | Full fund control — this is exactly why Option C (bounded Session Keys) is preferred over any architecture requiring this | **Total, per compromised user** | N/A | N/A |

**If a future implementation ever proposes storing a raw primary private key in Brohda's database**: per the gate document §9 and this task's own instruction, that must be treated as a major risk requiring dedicated security review before any approval — not something this document or the architecture gate pre-clears.

## 5. Threats, by category

Severity: **Critical** / **High** / **Medium** / **Low**. Mitigation status: **Planned** (designed in the architecture gate doc, not yet built), **Precedent exists** (a directly analogous pattern is already proven elsewhere in this codebase and should be reused), or **Unmitigated** (no design decision made yet).

| # | Threat | Severity | Mitigation status |
|---|---|---|---|
| 1 | Server compromise exposes stored Session Key material for one or more users | **Critical** | Planned — least-privilege secret access, server-only code path (gate doc §20); no implementation exists to verify |
| 2 | Database compromise exposes Session Key material (if ever stored in the DB rather than a dedicated secret store) | **Critical** | Planned — gate doc §20 states DB storage of secrets requires explicit architecture review and approval, not a default; **currently no such approval exists**, so this remains a live risk to design against, not a solved problem |
| 3 | Frontend/client compromise (XSS) leading to session hijacking, then abuse of the user's own delegated trading authority | **High** | Precedent exists — this codebase already has CSRF/XSS-relevant conventions (server-side auth checks, no client-trusted eligibility per Milestone 3's own `checkMarketEligibility` discipline); a future execution UI must inherit this, not invent a weaker model |
| 4 | Malicious or compromised admin using diagnostic tooling to infer or exfiltrate financially-actionable data | **Medium** | Planned — Prediction admin tooling already sets the precedent of read-only diagnostics, no mutation UI (gate doc §9/§31 item 16 calls for the same for execution); no execution admin tooling exists yet to audit |
| 5 | Compromised user session (stolen cookie/token) used to place unauthorized orders | **High** | Precedent exists — this codebase's existing session model (`requireUser()`) is the same one every other authenticated mutation already relies on; a future execution action inherits its existing strengths/weaknesses, none newly introduced by execution itself |
| 6 | Leaked API credentials (any server-side provider credential) | **High** | Planned — §20/this doc §4; no implementation exists |
| 7 | Leaked signing key / Session Key specifically | **High** (bounded from Critical only because of the no-withdrawal guarantee, §4) | Planned — provider-native revocation exists (gate doc §2.3); Brohda-side detection/rotation tooling does not exist yet |
| 8 | Compromised Builder credential | **Medium-High** | Unmitigated — no design exists yet beyond "use the provider's own credential-rotation tooling"; flagged as a genuine open item for Milestone 6 implementation, not resolved here |
| 9 | Supply-chain compromise (a malicious/compromised npm dependency with access to signing code) | **Critical** | Unmitigated architecturally beyond this codebase's ordinary dependency hygiene — no execution-specific supply-chain control (e.g. a minimal, audited signing-dependency surface) has been designed; **explicit gap, flagged for Milestone 6 security review** |
| 10 | Replay attack (resubmitting a previously-valid signed order request) | **High** | Planned — EIP-712 signed orders include a `salt` field (gate doc §2.1) intended to prevent exact replay; Brohda's own idempotency-key layer (§17 of the gate doc) is a second, independent defense at the application level |
| 11 | Duplicate submission (double-click, network retry) | **Medium** | Planned — directly reuses this codebase's own proven idempotency pattern (`create_pool_entry`, already reused for Predictions); gate doc §17 extends it for the provider-round-trip case specifically |
| 12 | Tampered order parameters (amount/side altered in transit or by a compromised client) | **High** | Precedent exists — EIP-712 signing itself cryptographically binds the signed fields (gate doc §2.1); a compromised *client* before signing is a session-compromise question (#5), not a transport question |
| 13 | Amount manipulation (a user or attacker submitting an amount inconsistent with what was quoted/confirmed) | **Medium** | Planned — the quote/confirmation flow (gate doc §12/§22) must re-validate the actual signed amount server-side against what was shown to the user, exactly mirroring how Prediction submission already re-validates eligibility server-side rather than trusting client state |
| 14 | Market-ID substitution (a request altered to target a different market than the user saw) | **Medium** | Planned — same server-side re-validation principle as #13; Prediction's own submission flow already re-fetches the market server-side rather than trusting a client-supplied market snapshot for eligibility (`lib/actions/predictions.ts`), the same discipline must extend to a future order action |
| 15 | Stale quote use (executing against an outdated price without the user's informed consent) | **Medium** | Planned — `Quote.expiresAt` (gate doc §12) and a server-side expiry check before any future order submission — the mechanism is designed, not implemented |
| 16 | CSRF | **Medium** | Precedent exists — Next.js Server Actions' own built-in CSRF protections already apply platform-wide; no execution-specific gap identified, but not independently re-verified for a hypothetical future execution-specific route handler (if one bypasses Server Actions) |
| 17 | XSS | **Medium** | Precedent exists — same as #3 |
| 18 | Session fixation | **Low-Medium** | Precedent exists — inherits Supabase Auth's existing session model, unchanged by execution |
| 19 | Privilege escalation (a player-tier user reaching admin-only execution controls, e.g. the kill switch) | **High** | Planned — must reuse the capability-policy architecture already proven for Prediction diagnostics (`view_prediction_diagnostics`) rather than a direct role check, per this codebase's own now-twice-corrected standing rule about authorization policy; no execution-specific capability exists yet since no execution admin surface exists |
| 20 | Insider misuse (a legitimate admin or engineer misusing legitimate access) | **Medium** | Planned — audit logging (gate doc §21) is the primary detective control; no preventive control beyond least-privilege scoping is designed, and none should be assumed sufficient on its own |
| 21 | Logging secrets accidentally (a future execution code path logging a Session Key, signature, or credential) | **High** | Planned — gate doc §21 explicitly enumerates what must never be logged; no execution logging code exists yet to audit against this list |
| 22 | Backup exposure (a database/secret-store backup containing execution secrets, subject to the same access controls as the primary store or weaker) | **Medium** | Unmitigated — no backup-specific policy has been designed for execution secrets; flagged as an open item, since this codebase's general backup posture was not audited as part of this milestone |
| 23 | Developer machine compromise (a local `.env.local` or similar containing a real Session Key or Builder credential during development/testing) | **High** | Planned — this codebase already has a hard-won precedent for exactly this class of mistake (`tests/integration/helpers/test-env.ts`'s own documented incident: production Supabase credentials leaking into a test run via shared env-var names) — any future execution secret handling must apply the same "separate namespace, hard local-only allowlist" discipline from day one, not retrofit it after an incident |

## 6. Quote/order substitution — dedicated note

Threats #13–#15 above collectively describe the "substitution" class this task's instructions call out by name. The unifying mitigation principle, consistent with every other Milestone 1–3 eligibility check already in this codebase, is: **the server must independently re-derive and re-validate every financially-relevant fact (market identity, current eligibility, quote freshness, amount) at the moment of submission — never trust a client-supplied value for anything that affects money movement.** This is not a new principle for Brohda; it is the exact discipline `lib/predictions/policy.ts`'s `checkMarketEligibility` already embodies for Predictions (re-reading the market and freshness state server-side rather than trusting what the client rendered). A future execution implementation that skips this discipline "for performance" would be a genuine regression from this codebase's own established standard, not a neutral tradeoff.

## 7. Webhook / event risks (if webhooks are ever used)

Not yet designed — gate doc §18 already establishes that a polling fallback must exist independent of any webhook mechanism, precisely because webhook/event loss is a real, undesigned-for risk today. If a future implementation adds webhook-based order/fill notifications, it must additionally address: webhook signature verification (to prevent spoofed events), idempotent event processing (a redelivered webhook must not double-process a fill), and ordering guarantees (a fill event arriving before its corresponding order-acknowledgement event must not corrupt state). None of this is designed in detail here, since no webhook integration exists or is proposed by this milestone — flagged for whoever designs Milestone 6's actual reconciliation implementation.

## 8. Reconciliation-specific risks

Covered in depth in the architecture gate document §18. The security-relevant framing: a reconciliation system that trusts Brohda's own cached state over the provider's is not just an accuracy bug, it is a **security-relevant integrity failure** — a user (or an attacker who has manipulated Brohda's cache) could otherwise convince Brohda's UI to display a financial outcome that was never actually true on the provider side. The source-of-truth hierarchy (provider authoritative, gate doc §18) is as much a security control as a correctness one.

## 9. Geographic/compliance bypass

A client-side-only geofencing check (e.g. hiding a button based on a client-reported country) is a **known-insufficient control** and must never be the sole enforcement mechanism, per the architecture gate document §14's own explicit instruction. Threat: a user spoofing their client-reported location, or using a VPN, to bypass an enforcement mechanism that only exists client-side. Mitigation status: **Planned, not designed in detail** — the specific server-side signals (IP geolocation, KYC-attested residency, provider-returned geofence result) are listed as candidates in gate doc §14 but none is selected, and no vendor is chosen (gate doc §27). This is an explicit, acknowledged gap appropriate for Milestone 4 to leave open, since resolving it fully requires the legal/compliance decisions (§5 of the gate doc) that determine what enforcement standard is even required.

## 10. Incident response requirements (future)

Not designed in operational detail by this milestone (that is properly a Milestone 6 pre-launch deliverable, gate doc §31 item 16's "dedicated security review" and the roadmap's own existing requirement for "a documented incident-response runbook for provider outage/reconciliation failure before rollout begins," roadmap §7 Milestone 6's own verification requirements). At minimum, a future incident-response plan must define: who can invoke the kill switch (gate doc §15) and under what conditions; how a suspected Session Key compromise is detected and responded to (revoke first, investigate second — never the reverse, given the bounded-but-real blast radius); how a reconciliation discrepancy that cannot be automatically resolved is escalated to a human; and how affected users are communicated with, consistent with the roadmap's own preserved "silence is never acceptable where trust is at stake" principle.

## 11. Summary — what this milestone changes about Brohda's risk posture today

**Nothing, yet.** No execution code exists. This document's purpose is to ensure that when execution code *does* get written (Milestone 6, gated on the architecture gate document's Decision Register being fully resolved), it is written against a threat model that was considered in advance — not discovered after an incident, which is exactly the pattern this codebase's own history shows happened twice already for a much lower-stakes class of bug (`SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md`'s two documented EXECUTE-grant-drift incidents). The single highest-leverage structural decision this document reinforces is the recommended architecture's own core property: **Brohda, under Option C, never holds a secret whose compromise allows fund withdrawal.** Every other threat above is real and must be mitigated, but none of them carries the unbounded blast radius that a primary-private-key-holding architecture (Option D, or a poorly-designed Option B) would carry by construction.
