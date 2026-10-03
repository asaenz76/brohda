import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

import { SearchInput } from "@/app/(app)/search/search-input";

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  currentSearch = "";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SearchInput", () => {
  it("does not navigate on its own: arriving on /search must not re-push /search (it used to override a click on another link)", () => {
    render(<SearchInput initialQuery="" />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(push).not.toHaveBeenCalled();
  });

  it("does not re-push the query it was opened with", () => {
    currentSearch = "q=bills";
    render(<SearchInput initialQuery="bills" />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(push).not.toHaveBeenCalled();
  });

  it("pushes the typed query once, after the debounce", () => {
    render(<SearchInput initialQuery="" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bills" } });
    act(() => void vi.advanceTimersByTime(200));
    expect(push).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(200));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/search?q=bills");
  });

  it("clearing the box returns to /search", () => {
    currentSearch = "q=bills";
    render(<SearchInput initialQuery="bills" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    act(() => void vi.advanceTimersByTime(400));
    expect(push).toHaveBeenCalledWith("/search");
  });
});
