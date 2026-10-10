import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTestAdapters, getAdapter, isRegisteredProvider, registeredProviders, registerTestAdapter } from "@/lib/payments/registry";
import { FakeProvider } from "../../helpers/fake-provider";

vi.mock("server-only", () => ({}));

afterEach(() => {
  clearTestAdapters();
  vi.unstubAllEnvs();
});

describe("provider registry", () => {
  it("production installs ONVO only; the fake provider is not there unless a test registers it", () => {
    expect(registeredProviders()).toEqual([{ key: "ONVO", label: "ONVO" }]);
    expect(getAdapter("TEST_PROVIDER")).toBeNull();
  });
  it("a test can register a second adapter, and it then appears as a selectable option", () => {
    registerTestAdapter(new FakeProvider());
    expect(registeredProviders().map((p) => p.key)).toEqual(["ONVO", "TEST_PROVIDER"]);
    expect(isRegisteredProvider("TEST_PROVIDER")).toBe(true);
  });
  it("registration is refused outside the test environment, so production code can never add an adapter at runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => registerTestAdapter(new FakeProvider())).toThrow();
  });
  it("unknown, empty and prototype-ish keys resolve to nothing", () => {
    for (const k of ["FOOBAR", "", null, undefined, "constructor", "__proto__", "toString"]) expect(getAdapter(k as string)).toBeNull();
  });
  it("ONVO declares its capabilities", () => {
    expect(getAdapter("ONVO")!.capabilities).toEqual({ supportsCheckout: true, supportsRefund: true, supportsPartialRefund: true, supportsReconciliation: true, supportsRefundWebhook: false });
  });
});
