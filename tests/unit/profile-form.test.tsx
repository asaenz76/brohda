import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actions/profile", () => ({
  updateProfileAction: vi.fn(async () => ({ error: null, success: false })),
  changePasswordAction: vi.fn(async () => ({ error: null, success: false })),
}));

const { ProfileForm } = await import("@/app/(app)/profile/profile-form");

afterEach(() => cleanup());

describe("ProfileForm bio character countdown", () => {
  it("shows 0/150 with no bio, and updates live as the user types", () => {
    render(
      <ProfileForm
        displayName="Bob"
        username={null}
        pronouns={null}
        gender={null}
        bio={null}
        showPronouns
        showGender
        showBio
        emailNotificationsEnabled
      />,
    );

    expect(screen.getByText("0/150")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Short bio"), {
      target: { value: "Just here to predict some outcomes." },
    });

    expect(screen.getByText("35/150")).toBeInTheDocument();
  });

  it("initializes the countdown from an existing bio", () => {
    render(
      <ProfileForm
        displayName="Bob"
        username={null}
        pronouns={null}
        gender={null}
        bio="Hello there"
        showPronouns
        showGender
        showBio
        emailNotificationsEnabled
      />,
    );

    expect(screen.getByText("11/150")).toBeInTheDocument();
  });
});
