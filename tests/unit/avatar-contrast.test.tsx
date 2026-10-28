import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({ default: (props: { alt: string }) => <span role="img" aria-label={props.alt} /> }));

import { Avatar } from "@/components/Avatar";

afterEach(() => cleanup());

describe("Avatar fallback initials", () => {
  // M6 accessibility fix: the initials sat at 4.42:1 (#737373 on #f7f7f7), just under WCAG AA's 4.5:1 for normal text, on every page that shows a Member (found by an axe scan of the leaderboard).
  it("uses the primary text colour, not the secondary one, on the elevated surface", () => {
    render(<Avatar displayName="Maria Lopez" avatarUrl={null} />);
    const initials = screen.getByRole("img", { name: "Maria Lopez" });
    expect(initials).toHaveTextContent("ML");
    expect(initials.className).toContain("text-text-primary");
    expect(initials.className).not.toContain("text-text-secondary");
  });
});
