import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlideToConfirm } from "@/components/pools/SlideToConfirm";

// jsdom doesn't implement ResizeObserver — SlideToConfirm only uses it to
// measure the track's pixel width, irrelevant to the confirm-feedback
// behavior under test here. Re-stubbed before every test (not just once)
// since a test that calls vi.unstubAllGlobals() to restore `navigator`
// would otherwise also wipe this one out for the next test.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => cleanup());

describe("SlideToConfirm confirm feedback", () => {
  it("confirms and fires a haptic buzz when the tap fallback is used", () => {
    const onConfirm = vi.fn();
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, vibrate });

    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);
    fireEvent.click(screen.getByText("Or tap here to confirm"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(15);

    vi.unstubAllGlobals();
  });

  it("confirms via keyboard (Enter) on the slider thumb", () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);

    fireEvent.keyDown(screen.getByRole("slider"), { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("never confirms while pending", () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm onConfirm={onConfirm} pending={true} />);

    fireEvent.click(screen.getByText("Locking in…"));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("silently no-ops when the Vibration API isn't supported (e.g. iOS Safari)", () => {
    const onConfirm = vi.fn();
    // navigator.vibrate is absent entirely on iOS Safari — confirm still works.
    vi.stubGlobal("navigator", { ...navigator, vibrate: undefined });

    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);
    expect(() => fireEvent.click(screen.getByText("Or tap here to confirm"))).not.toThrow();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
