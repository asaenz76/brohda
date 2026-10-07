import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TermsDocument } from "@/components/legal/TermsDocument";
import { PrivacyDocument } from "@/components/legal/PrivacyDocument";

// These assertions describe the complete documents (optional money ON). What changes when money is off is covered in legal-money-gating.test.tsx.
const TermsPage = () => <TermsDocument mode="active" />;
const PrivacyPage = () => <PrivacyDocument mode="active" />;
import { RulesContent } from "@/components/rules/RulesContent";
import { UNKNOWN_RULES_POLICY } from "@/lib/rules/format";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";

afterEach(() => cleanup());

const text = (node: React.ReactElement) => {
  const { container, unmount } = render(node);
  const out = (container.textContent ?? "").replace(/\s+/g, " ");
  unmount();
  return out;
};

// The V1 product was private groups running prediction pools: organizers, entry fees, who owes whom, group administrators, a leaderboard.
// Brohda 2.0 publishes Game Posts that members make Picks on. These pages must describe the current product and not that one.
const V1_PRODUCT = [
  [/\bpools?\b/i, "pool"],
  [/pool organi[sz]er/i, "pool organizer"],
  [/entry fees?/i, "entry fee"],
  [/\bowes\b|who owes|owes or is owed/i, "who owes what"],
  [/\bleaderboards?\b/i, "leaderboard"],
  [/\blikes\b/i, "likes (there is no likes feature)"],
  [/private group|group administrators?|your group|the group's|the group&apos;s/i, "private-group framing"],
  [/invite-only|private, invite/i, "invite-only framing"],
] as const;

describe("Terms describe Brohda 2.0, not the old Pool product", () => {
  const terms = text(<TermsPage />);

  it.each(V1_PRODUCT)("contains no %s wording (%s)", (pattern) => {
    expect(terms).not.toMatch(pattern);
  });

  it("describes the current product in the Service's own terms", () => {
    expect(terms).toContain("a social network built around real sporting events");
    expect(terms).toContain("publishes the games");
    expect(terms).toContain("make Picks on them, comment");
    expect(terms).toContain("Call BS");
    expect(terms).toContain("Members do not create games or competitions");
    expect(terms).toContain("optional money Position");
    expect(terms).toContain("Where optional money Positions are enabled");
  });

  it("no longer makes the two claims the implementation contradicts", () => {
    // The wallet is not "a record-keeping tool only" and the Company is not described as holding no member's money: balances are kept,
    // reserved for offers and Positions, settled in the ledger, charged a fee, and paid out on withdrawal.
    expect(terms).not.toMatch(/record-?keeping tool only/i);
    expect(terms).not.toMatch(/facilitator of recordkeeping/i);
    expect(terms).not.toMatch(/does not accept, hold, custody, transmit, or have access to any member/i);
    expect(terms).not.toMatch(/all real-money transactions happen off-platform/i);
  });

  it("describes what the wallet and money functionality actually do, neutrally", () => {
    expect(terms).toContain('The Service includes an in-app "wallet" balance.');
    expect(terms).toContain("Where the optional money functionality is enabled");
    expect(terms).toContain("may add funds to their wallet balance and may request a withdrawal");
    expect(terms).toContain("subject to an administrator's review and confirmation");
    expect(terms).toContain("commits part of their wallet balance to that Position");
    expect(terms).toContain("records the amount as reserved while the Position is open");
    expect(terms).toContain("settles the Position by updating the wallet balances of the two members according to the Market's result");
    expect(terms).toContain("If a Position is voided, the reserved amounts are released.");
    expect(terms).toContain("The Service may deduct a platform fee as described in Section 5.");
    expect(terms).toContain("A money Position is private to the two members involved and to authorized administrators.");
    expect(terms).toContain("3. Deposits and withdrawals happen outside the App");
    expect(terms).toContain("together with the results of settled Positions");
  });

  it("adds no legal classification of its own: custody / escrow / transmitter / sportsbook language appears only in the one retained owner-authored sentence", () => {
    const retained = "The Company is not a bank, money transmitter, payment processor, escrow agent, broker, bookmaker, gambling operator, or party to any wager, bet, or contest between members.";
    expect(terms).toContain(retained); // kept verbatim for owner/counsel review (docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md, B3)
    const everythingElse = terms.replace(retained, "");
    expect(everythingElse).not.toMatch(/custod|escrow|money transmitter|sportsbook|financial institution|\bbroker|\bbookmaker|trust(ee)? account|\bholds? (your|the member's|members') (money|funds)\b|safeguard/i);
    // The Terms say nothing about the legal status of the funds or the activity beyond that sentence.
    expect(everythingElse).not.toMatch(/licen[sc]ed|regulated|legal tender|owned by (the )?(company|member)|belongs? to (the )?(company|member)/i);
  });

  it("keeps the other substantive legal provisions exactly as they were (they are for the owner and counsel, not for a copy pass)", () => {
    expect(terms).toContain("not exceed one hundred U.S. dollars (US$100)");
    expect(terms).toContain("governed by the laws of Costa Rica");
    expect(terms).toContain("You must be at least 18 years old");
    expect(terms).toContain("Their good-faith decisions regarding the App's records are final.");
    expect(terms).toContain("including any dispute over money you sent or received off-platform");
  });
});

describe("Privacy describes what the product does today", () => {
  const privacy = text(<PrivacyPage />);

  it.each(V1_PRODUCT)("contains no %s wording (%s)", (pattern) => {
    expect(privacy).not.toMatch(pattern);
  });

  it("names the current data concepts: Picks, comments, Call BS, follows, notifications, wallet and money records, administrative records", () => {
    for (const phrase of ["your Picks", "comments", "Call BS challenges", "you follow", "notifications", "Wallet and money records", "Administrative and security records"]) {
      expect(privacy).toContain(phrase);
    }
  });

  it("states the locked money-privacy rule — private to the two members and authorized administrators — without claiming more", () => {
    expect(privacy).toContain("Money is private to the people involved.");
    expect(privacy).toContain("visible to those two members and to authorized administrators");
    expect(privacy).toContain("money notifications are sent only to the two members involved");
    expect(privacy).toContain("No other member can see it.");
    // It does not promise that nobody at all can see it: administrators and infrastructure operators can.
    expect(privacy).toContain("the people who operate the Service's infrastructure can access stored data");
    expect(privacy).not.toMatch(/end-to-end|encrypted so that|no one (at brohda|can ever)/i);
  });

  it("keeps the financial disclosure independent of whether the money feature is currently on (stored and historical records still exist)", () => {
    expect(privacy).toContain("are or have been enabled");
  });

  it("keeps what logged-out visitors can see: aggregate only", () => {
    expect(privacy).toContain("People who are not signed in see only aggregate information");
  });

  it("does not change the promises about what is not collected or sold", () => {
    expect(privacy).toContain("we never receive, process, or store your bank account number, card number, payment app login credentials, or government identification");
    expect(privacy).toContain("We do not sell your information to anyone, and we do not share it with advertisers.");
    expect(privacy).toContain("We do not use advertising or cross-site tracking cookies.");
  });
});

describe("Rules, Terms and Privacy use one vocabulary", () => {
  const rules = text(<RulesContent policy={{ ...UNKNOWN_RULES_POLICY, monetaryEnabled: true }} />);
  const terms = text(<TermsPage />);
  const privacy = text(<PrivacyPage />);

  it("each uses Pick, Call BS and (where it speaks of money) Position — and none reverts to the old words", () => {
    for (const doc of [rules, terms, privacy]) {
      expect(doc).toContain("Call BS");
      expect(doc).not.toMatch(/\bpools?\b|entry fee|\bleaderboards?\b|private group|\bsubmit(ted)? (a|your) (entry|prediction pool)\b/i);
    }
    expect(rules).toContain("Pick");
    expect(terms).toContain("Picks");
    expect(privacy).toContain("Picks");
    for (const doc of [rules, terms, privacy]) expect(doc).toContain("Position");
  });

  it("Rules says a tied Moneyline is voided, and Terms and Privacy don't contradict it with another grading model", () => {
    expect(rules).toContain("if a Moneyline ends tied (so neither team won)");
    expect(terms + privacy).not.toMatch(/\bdraw\b|\btie\b|ties resolve/i);
  });
});

describe("Terms cover conduct, in plain language, without inventing enforcement tools", () => {
  const terms = text(<TermsPage />);

  it("names harassment, threats, abuse, spam, scams, impersonation, unlawful content and other people's private information", () => {
    expect(terms).toContain("Harass, threaten, or abuse other people");
    expect(terms).toContain("post content that attacks people for who they are");
    expect(terms).toContain("Post spam or scams, or pretend to be someone else");
    expect(terms).toContain("Post unlawful content, or other people's private information");
  });

  it("states the authority the product actually has: moderators remove content (comments), accounts can be suspended or closed", () => {
    expect(terms).toContain("We and our moderators may remove content, including comments");
    expect(terms).toContain("suspend or close an account at our discretion, with or without notice (see Section 11)");
    expect(terms).toContain("tell us at support@brohda.com");
  });

  it("promises no tool that doesn't exist: no strikes, appeals, warnings systems, automated enforcement, or feature limits", () => {
    expect(terms).not.toMatch(/strike|appeal|warning system|automated|automatic(ally)? (remove|suspend)|limit (your )?features|shadow|ban list|probation/i);
  });

  it("the Rules' pointer to the Terms for what isn't allowed now points at something", () => {
    const rules = text(<RulesContent policy={UNKNOWN_RULES_POLICY} />);
    expect(rules).toContain("What isn't allowed on Brohda is covered in the Terms.");
    expect(terms).toContain("6. Your conduct");
  });
});

describe("Privacy matches what the audit proved the implementation does", () => {
  const privacy = text(<PrivacyPage />);

  it("discloses the optional profile fields (pronouns, gender, bio) and their show/hide switch", () => {
    expect(privacy).toContain("pronouns, a gender, and a short bio");
    expect(privacy).toContain("each is optional and has its own switch to show or hide it");
  });

  it("states that a withdrawal payout destination is entered by the member, and who can see it", () => {
    expect(privacy).toContain("When you request a withdrawal you also enter where you want to be paid");
    expect(privacy).toContain("The payout destination you enter when you request a withdrawal is provided by you");
    expect(privacy).toContain("visible to you and to the administrators who process the request, and is recorded on the resulting ledger entry");
  });

  it("names the providers and describes error monitoring and email without claiming less data than is sent", () => {
    for (const vendor of ["Vercel", "Supabase", "API-Sports", "Sentry", "Resend"]) expect(privacy).toContain(vendor);
    expect(privacy).toContain("the page address, browser and device type, timing, and the technical details of the error");
    expect(privacy).toContain("an error message or page address can incidentally include identifiers");
    expect(privacy).toContain("it does not record your session");
    expect(privacy).toContain("receives your email address and the content of the message");
    expect(privacy).not.toMatch(/never (send|share|transmit)|anonymi[sz]ed|no personal data|we do not send/i);
  });

  it("attributes IP / browser logs to the providers that log them, and claims no IP collection of our own", () => {
    expect(privacy).toContain("which our hosting and infrastructure providers log when you use the Service");
    expect(privacy).not.toMatch(/we (record|store|collect|log) your ip/i);
  });

  it("describes account closure truthfully: what is removed, and what is kept because it is the Service's history", () => {
    expect(privacy).toContain("once your wallet balance is zero and you have no pending wallet requests");
    expect(privacy).toContain("permanently removes your name, username, photo, and optional profile details from your profile");
    expect(privacy).toContain("your email address stays reserved and cannot be used to register again");
    expect(privacy).toContain("your Picks and comments (shown as \"Deleted User\")");
    expect(privacy).toContain("the wallet and money ledger");
    expect(privacy).toContain("records of administrator actions (which may keep the name and username the account had before it was closed)");
    expect(privacy).toContain("which versions of the Terms and Privacy Policy you accepted");
    expect(privacy).toContain("kept as permanent records of the Service's ledger");
  });

  it("no longer promises deletion of everything on request, which the append-only ledger and audit records can't honour", () => {
    expect(privacy).not.toMatch(/deletion of your information/i);
  });
});

describe("the effective date and version come from one place", () => {
  it("each page shows the date configured in lib/legal/documents.ts", () => {
    expect(text(<TermsPage />)).toContain(`Effective ${LEGAL_DOCUMENTS.terms.effectiveDate}`);
    expect(text(<PrivacyPage />)).toContain(`Effective ${LEGAL_DOCUMENTS.privacy.effectiveDate}`);
  });

  it("every document has a non-empty version identifier (what an acceptance records)", () => {
    for (const doc of Object.values(LEGAL_DOCUMENTS)) {
      expect(doc.version.length).toBeGreaterThan(0);
      expect(doc.effectiveDate.length).toBeGreaterThan(0);
    }
  });
});
