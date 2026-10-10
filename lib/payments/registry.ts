import "server-only";
import { OnvoProvider } from "./onvo/adapter";
import type { CommercialPaymentProvider } from "./types";

// THE provider registry: the one canonical place that says which payment adapters this deployment of Brohda knows how to run. A provider key stored anywhere (the active-provider
// setting, an attempt, a webhook route) is only ever looked up here — never executed from data, and an unknown key simply is not found (callers fail closed).
//
// Adding a provider = writing its adapter once and adding ONE line below. Switching, enabling or disabling among registered providers is configuration and needs no code.
type AdapterFactory = () => CommercialPaymentProvider;

const ADAPTERS: Readonly<Record<string, AdapterFactory>> = {
  ONVO: () => new OnvoProvider(),
};

// Test-only registrations (a fake second provider, or an adapter wired to a sandbox). They exist only when NODE_ENV is "test", so production code can never register one.
const testAdapters = new Map<string, CommercialPaymentProvider>();

export function registerTestAdapter(adapter: CommercialPaymentProvider): void {
  if (process.env.NODE_ENV !== "test") throw new Error("registerTestAdapter is only available under test");
  testAdapters.set(adapter.key, adapter);
}

export function clearTestAdapters(): void {
  testAdapters.clear();
}

/** The adapter for a provider key, or null when this deployment doesn't have it. */
export function getAdapter(key: string | null | undefined): CommercialPaymentProvider | null {
  if (!key) return null;
  const injected = testAdapters.get(key);
  if (injected) return injected;
  const factory = Object.prototype.hasOwnProperty.call(ADAPTERS, key) ? ADAPTERS[key] : undefined;
  return factory ? factory() : null;
}

/** Every provider a Super Admin may select (installed adapters only; the list that the UI offers and the server accepts). */
export function registeredProviders(): Array<{ key: string; label: string }> {
  const keys = new Set([...Object.keys(ADAPTERS), ...testAdapters.keys()]);
  return [...keys].sort().map((key) => ({ key, label: getAdapter(key)!.label }));
}

export function isRegisteredProvider(key: string | null | undefined): boolean {
  return getAdapter(key) !== null;
}
