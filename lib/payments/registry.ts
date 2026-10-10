import "server-only";
import { OnvoProvider } from "./onvo/adapter";
import type { CommercialPaymentProvider } from "./types";

/** The one place that names which provider adapter is wired in. MANUAL payments do not go through a provider adapter (they are recorded by Super Admin). */
export function getCommercialPaymentProvider(): CommercialPaymentProvider {
  return new OnvoProvider();
}
