import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PoolMetadata } from "@/components/pools/PoolMetadata";

afterEach(() => cleanup());

describe("PoolMetadata", () => {
  it("shows Public for VISIBLE_TO_ALL_MEMBERS", () => {
    render(<PoolMetadata visibility="VISIBLE_TO_ALL_MEMBERS" createdAt={new Date().toISOString()} />);
    expect(screen.getByText(/Public/)).toBeInTheDocument();
  });

  it("shows Private for HIDDEN", () => {
    render(<PoolMetadata visibility="HIDDEN" createdAt={new Date().toISOString()} />);
    expect(screen.getByText(/Private/)).toBeInTheDocument();
  });

  it("shows relative posted time", () => {
    render(<PoolMetadata visibility="HIDDEN" createdAt={new Date(Date.now() - 45 * 60_000).toISOString()} />);
    expect(screen.getByText(/Posted 45m ago/)).toBeInTheDocument();
  });
});
