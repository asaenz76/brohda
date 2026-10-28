import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/lib/actions/auth";

vi.mock("@/lib/actions/auth", () => ({ registerAction: vi.fn() }));

import { RegisterForm } from "@/app/(auth)/register/register-form";

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(registerAction).mockReset();
});

const submit = () => fireEvent.click(screen.getByRole("button", { name: /^join/i }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });

describe("RegisterForm — the whole sign-up on one screen", () => {
  it("shows every field and the submit button at once: no steps, no Continue, no name", () => {
    render(<RegisterForm />);
    for (const label of ["Email", "Password", "Username"]) expect(screen.getByLabelText(label, { exact: true })).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeVisible();
    expect(screen.getByRole("button", { name: /^join/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /continue|back/i })).toBeNull();
    expect(screen.queryByLabelText(/what should we call you|display name|your name/i)).toBeNull();
  });

  it("is friendly to password managers and phone keyboards", () => {
    render(<RegisterForm />);
    const email = screen.getByLabelText("Email", { exact: true });
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toHaveAttribute("inputmode", "email");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("type", "password");
    // The handle is not a login name here (login is by email), so a password manager is not told it is one.
    expect(screen.getByLabelText("Username", { exact: true })).toHaveAttribute("autocomplete", "nickname");
    expect(screen.getByLabelText("Username", { exact: true })).toHaveAttribute("autocapitalize", "none");
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute("type", "button");
  });

  it("keeps the legal acceptance: the same required checkbox and the same Terms / Policy links", () => {
    render(<RegisterForm />);
    expect(screen.getByRole("checkbox")).toBeRequired();
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByText(/I have read and agree to the/)).toBeInTheDocument();
  });

  it("carries the Game the visitor came for as a hidden return path, and only when there is one", () => {
    const { container, rerender } = render(<RegisterForm next="/post/abc?pick=YES" />);
    expect(container.querySelector('input[name="next"]')).toHaveValue("/post/abc?pick=YES");
    rerender(<RegisterForm />);
    expect(container.querySelector('input[name="next"]')).toBeNull();
  });

  it("a rejected sign-up says which field, keeps everything typed (the password too), and focuses the field", async () => {
    vi.mocked(registerAction).mockResolvedValue({ error: null, fieldErrors: { username: "That username is taken. Try another." } });
    render(<RegisterForm next="/post/abc?pick=YES" />);
    type("Email", "fan@example.com");
    type("Password", "supersecret1");
    type("Username", "taken");
    fireEvent.click(screen.getByRole("checkbox"));
    submit();
    await waitFor(() => expect(screen.getByText("That username is taken. Try another.")).toBeInTheDocument());
    expect(screen.getByLabelText("Email", { exact: true })).toHaveValue("fan@example.com");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("supersecret1");
    expect(screen.getByLabelText("Username", { exact: true })).toHaveValue("taken");
    expect(screen.getByLabelText("Username", { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Username", { exact: true })).toHaveAccessibleDescription(/That username is taken/);
    await waitFor(() => expect(screen.getByLabelText("Username", { exact: true })).toHaveFocus());
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("an email that already has an account offers Log in, carrying the Game (never the email)", async () => {
    vi.mocked(registerAction).mockResolvedValue({ error: null, fieldErrors: { email: "An account with this email already exists." }, existingAccount: true });
    render(<RegisterForm next="/post/abc?pick=NO" />);
    type("Email", "fan@example.com");
    type("Password", "supersecret1");
    type("Username", "newfan");
    fireEvent.click(screen.getByRole("checkbox"));
    submit();
    const link = await screen.findByRole("link", { name: "Log in instead" });
    expect(link).toHaveAttribute("href", `/login?next=${encodeURIComponent("/post/abc?pick=NO")}`);
    expect(link.getAttribute("href")).not.toContain("fan");
  });

  it("a problem that belongs to no field is announced, not hidden", async () => {
    vi.mocked(registerAction).mockResolvedValue({ error: "Too many attempts. Please try again in a few minutes." });
    render(<RegisterForm />);
    type("Email", "fan@example.com");
    type("Password", "supersecret1");
    type("Username", "newfan");
    fireEvent.click(screen.getByRole("checkbox"));
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
  });

  it("disables the button while a sign-up is in flight, so a second tap cannot send a second one", async () => {
    let release: (v: { error: string | null }) => void = () => {};
    vi.mocked(registerAction).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    render(<RegisterForm />);
    type("Email", "fan@example.com");
    type("Password", "supersecret1");
    type("Username", "newfan");
    fireEvent.click(screen.getByRole("checkbox"));
    submit();
    const pending = await screen.findByRole("button", { name: "Creating account…" });
    expect(pending).toBeDisabled();
    expect(registerAction).toHaveBeenCalledTimes(1);
    await act(async () => release({ error: "Could not create your account." }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^join/i })).toBeEnabled();
  });
});
