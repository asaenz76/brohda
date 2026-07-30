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

  it("plays a two-note chime via Web Audio when confirming — the one channel that actually reaches iOS", () => {
    const onConfirm = vi.fn();
    const oscillators: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    class FakeAudioContext {
      currentTime = 0;
      close = vi.fn();
      createOscillator() {
        const osc = { type: "sine", frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        oscillators.push(osc);
        return osc;
      }
      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);
    fireEvent.click(screen.getByText("Or tap here to confirm"));

    expect(oscillators).toHaveLength(2); // two ascending notes
    oscillators.forEach((osc) => {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    });

    vi.unstubAllGlobals();
  });

  it("silently no-ops when Web Audio isn't available at all", () => {
    const onConfirm = vi.fn();
    vi.stubGlobal("AudioContext", undefined);

    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);
    expect(() => fireEvent.click(screen.getByText("Or tap here to confirm"))).not.toThrow();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("confirms a drag gesture even when pointerup fires on window rather than the thumb (the real-device case this fixes — WebKit doesn't reliably re-deliver pointerup to the drag's origin element)", () => {
    const onConfirm = vi.fn();
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, vibrate });

    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);
    const thumb = screen.getByRole("slider");

    fireEvent.pointerDown(thumb, { clientX: 0 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 50 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 50 }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(15);

    vi.unstubAllGlobals();
  });

  it("snaps back without confirming when released below the threshold", () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);
    const thumb = screen.getByRole("slider");

    fireEvent.pointerDown(thumb, { clientX: 0 });
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 0 }));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("snaps back without confirming on pointercancel, even mid-drag past the threshold position", () => {
    const onConfirm = vi.fn();
    render(<SlideToConfirm onConfirm={onConfirm} pending={false} />);
    const thumb = screen.getByRole("slider");

    fireEvent.pointerDown(thumb, { clientX: 0 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 50 }));
    window.dispatchEvent(new PointerEvent("pointercancel", { clientX: 50 }));

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
