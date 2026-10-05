import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/lib/actions/wallet-requests", () => ({ submitWalletRequestAction: vi.fn() }));
vi.mock("@/lib/actions/account", () => ({ closeAccountAction: vi.fn() }));

import { WalletRequestForm } from "@/app/(app)/wallet/wallet-request-form";
import { CloseAccountForm } from "@/app/(app)/profile/close-account-form";
import { fireEvent } from "@testing-library/react";

describe("WalletRequestForm — funding follows the consumer money capability", () => {
  it("offers both Add Funds and Transfer Out by default", () => {
    render(<WalletRequestForm paymentMethods={[]} />);
    expect(screen.getByRole("button", { name: /add funds/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transfer out/i })).toBeInTheDocument();
  });

  it("with funding off, only Transfer Out remains: money can always leave, but nothing new comes in", () => {
    render(<WalletRequestForm paymentMethods={[]} allowFunding={false} />);
    expect(screen.queryByRole("button", { name: /add funds/i })).toBeNull();
    expect(screen.getByRole("button", { name: /transfer out/i })).toBeInTheDocument();
  });
});

describe("CloseAccountForm — money conditions only for someone who can see money", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Close account" }));

  it("with money visible, mentions the balance and pending requests", () => {
    const { container } = render(<CloseAccountForm showMoney />);
    open();
    expect(container.textContent).toContain("$0 balance");
    expect(container.textContent).toContain("pending deposit or withdrawal request");
  });

  it("without money, names only picks in progress — no balance, deposit or withdrawal wording", () => {
    const { container } = render(<CloseAccountForm showMoney={false} />);
    open();
    expect(container.textContent).toContain("You’ll need no picks still in progress.");
    expect(container.textContent).not.toMatch(/balance|deposit|withdraw|\$/i);
  });
});
