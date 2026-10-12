import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SponsorPaymentPanel } from "@/components/sponsorship/SponsorPaymentPanel";
import type { PaymentEligibility } from "@/lib/sponsorship/payment-eligibility";

vi.mock("@/lib/actions/sponsorship-payments", () => ({ startSponsorPaymentAction: async () => {} }));
afterEach(() => cleanup());

const panel = (o: Partial<React.ComponentProps<typeof SponsorPaymentPanel>> = {}, eligibility: PaymentEligibility = { state: "PAY_NOW" }) =>
  render(<SponsorPaymentPanel sponsorshipId="11111111-1111-4111-8111-111111111111" priceCents={90000} currency="USD" lifecycle="SUBMITTED" reviewStatus="PENDING" paymentStatus="PENDING" latestAttemptStatus={null} eligibility={eligibility} idempotencyKey="key-12345678" notice={null} {...o} />);

describe("the Sponsor's payment section", () => {
  it("shows the frozen amount, the currency and the status — and, when every gate passes, Pay now (and nothing that names a provider)", () => {
    const { container } = panel();
    expect(container.querySelector('[data-slot="payment-amount"]')).toHaveTextContent("$900.00");
    expect(container.querySelector('[data-slot="payment-currency"]')).toHaveTextContent("USD");
    expect(container.querySelector('[data-slot="payment-state"]')).toHaveTextContent("Unpaid");
    expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/onvo|stripe|paypal|processor/i);
  });

  it("the form carries the sponsorship and a de-duplication key — NEVER an amount, a currency or a provider", () => {
    const { container } = panel();
    const names = [...container.querySelectorAll("form input")].map((i) => i.getAttribute("name"));
    expect(names.sort()).toEqual(["idempotencyKey", "sponsorshipId"]);
    expect(container.querySelector('input[name*="amount" i], input[name*="price" i], input[name*="currency" i], input[name*="provider" i]')).toBeNull();
  });

  it("a missing legal acceptance shows what to do, and NO Pay now button", () => {
    const { container } = panel({}, { state: "LEGAL_BLOCKED", missing: ["SPONSOR_TERMS"] });
    expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
    expect(container.querySelector('[data-slot="legal-block"]')).toHaveTextContent(/accept the current Sponsor Terms/i);
  });

  it("online payment unavailable (off, or the provider isn't configured) → a plain note, no broken button", () => {
    const { container } = panel({}, { state: "ONLINE_UNAVAILABLE" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[data-slot="online-unavailable"]')).toHaveTextContent("Online payment isn't available right now.");
  });

  it("manual fallback: when the owner has provided instructions they are offered beside online payment — and beside nothing when online is unavailable", () => {
    const { container } = panel({ manualInstructions: "Transfer to account X.\nUse reference BROHDA-1." });
    const d = container.querySelector('[data-slot="manual-instructions"]')!;
    expect(d.querySelector("summary")).toHaveTextContent("View manual payment instructions");
    expect(d).toHaveTextContent("Use reference BROHDA-1.");
    expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
    cleanup();
    const unavailable = panel({ manualInstructions: "Transfer to account X." }, { state: "ONLINE_UNAVAILABLE" });
    expect(unavailable.container.querySelector('[data-slot="manual-instructions"]')).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("no instructions set → no manual disclosure at all", () => {
    expect(panel().container.querySelector('[data-slot="manual-instructions"]')).toBeNull();
  });

  it("an open attempt reads Pending; failed reads Failed and still offers a retry", () => {
    expect(panel({ latestAttemptStatus: "PENDING" }).container.querySelector('[data-slot="payment-state"]')).toHaveTextContent("Pending");
    cleanup();
    const failed = panel({ paymentStatus: "FAILED" });
    expect(failed.container.querySelector('[data-slot="payment-status"]')).toHaveTextContent("Payment failed — you can try again.");
    expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
  });

  it("paid, not approved: 'Payment received. Your sponsorship is awaiting Brohda approval.' — no Pay now, no approval claimed", () => {
    const { container } = panel({ paymentStatus: "PAID" }, { state: "NOT_PAYABLE", reason: "ALREADY_PAID" });
    expect(container.querySelector('[data-slot="payment-state"]')).toHaveTextContent("Paid");
    expect(container.querySelector('[data-slot="payment-status"]')).toHaveTextContent("Payment received. Your sponsorship is awaiting Brohda approval.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("paid and approved and on the clock reads scheduled", () => {
    const { container } = panel({ paymentStatus: "PAID", lifecycle: "SCHEDULED", reviewStatus: "APPROVED" }, { state: "NOT_PAYABLE", reason: "ALREADY_PAID" });
    expect(container.querySelector('[data-slot="payment-status"]')).toHaveTextContent("Payment received. Your sponsorship is approved and scheduled.");
  });

  it("a cancelled sponsorship shows its state and no button", () => {
    const { container } = panel({ lifecycle: "CANCELLED", paymentStatus: "REFUNDED" }, { state: "NOT_PAYABLE", reason: "CANCELLED_OR_ENDED" });
    expect(container.querySelector('[data-slot="payment-state"]')).toHaveTextContent("Refunded");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a returned-from-payment note never changes the status shown", () => {
    const { container } = panel({ notice: "left" });
    expect(container).toHaveTextContent("You left the payment page before it finished.");
    expect(container.querySelector('[data-slot="payment-state"]')).toHaveTextContent("Unpaid");
  });
});
