import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallAppButton } from "@/components/InstallAppButton";

function stubUserAgent(ua: string, maxTouchPoints = 0) {
  vi.stubGlobal("navigator", { ...navigator, userAgent: ua, maxTouchPoints });
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const IOS_SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InstallAppButton", () => {
  it("renders nothing on a browser with neither an install prompt nor iOS Safari", () => {
    stubUserAgent(ANDROID_CHROME_UA); // beforeinstallprompt never fires in this test
    stubMatchMedia(false);

    render(<InstallAppButton />);

    expect(screen.queryByLabelText("Get the app")).not.toBeInTheDocument();
  });

  it("shows the button and triggers the native prompt once beforeinstallprompt fires (Android/Chrome)", async () => {
    stubUserAgent(ANDROID_CHROME_UA);
    stubMatchMedia(false);
    render(<InstallAppButton />);

    const prompt = vi.fn().mockResolvedValue(undefined);
    const userChoice = Promise.resolve({ outcome: "accepted" as const });
    const bipEvent = Object.assign(new Event("beforeinstallprompt"), { prompt, userChoice });
    fireEvent(window, bipEvent);

    const button = await screen.findByLabelText("Get the app");
    fireEvent.click(button);

    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("shows the button and opens the manual instructions sheet on iOS Safari (no install API exists there)", () => {
    stubUserAgent(IOS_SAFARI_UA, 5);
    stubMatchMedia(false);
    render(<InstallAppButton />);

    const button = screen.getByLabelText("Get the app");
    fireEvent.click(button);

    expect(screen.getByRole("dialog", { name: "Add brohda. to your Home Screen" })).toBeInTheDocument();
    expect(screen.getByText(/Add to Home/)).toBeInTheDocument();
  });

  it("portals the iOS instructions sheet to document.body, not the trigger's own DOM subtree", () => {
    // Regression test for a real production bug: LandingNav's header has
    // backdrop-blur, and backdrop-filter (like filter) creates a new
    // containing block for position:fixed descendants — without the
    // portal, "fixed inset-0" resolves against that header's own small box
    // instead of the viewport, confining the sheet to a sliver under the
    // nav bar. jsdom doesn't compute real CSS layout so it can't catch the
    // visual symptom directly; this at least locks in the portal target.
    stubUserAgent(IOS_SAFARI_UA, 5);
    stubMatchMedia(false);
    const { container } = render(
      <div style={{ filter: "blur(0px)" }}>
        <InstallAppButton />
      </div>,
    );

    fireEvent.click(screen.getByLabelText("Get the app"));

    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("closes the iOS instructions sheet on Escape or backdrop click", () => {
    stubUserAgent(IOS_SAFARI_UA, 5);
    stubMatchMedia(false);
    render(<InstallAppButton />);

    fireEvent.click(screen.getByLabelText("Get the app"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders nothing when already running standalone (already installed)", () => {
    stubUserAgent(ANDROID_CHROME_UA);
    stubMatchMedia(true); // display-mode: standalone matches

    render(<InstallAppButton />);

    expect(screen.queryByLabelText("Get the app")).not.toBeInTheDocument();
  });
});
