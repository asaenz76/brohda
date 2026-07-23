import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { PaymentMethod } from "./constants";

export interface PaymentMethodRow {
  method: PaymentMethod;
  enabled: boolean;
  destination: string | null;
  instructions: string | null;
}

// Readable by anyone authenticated (RLS grants select to `authenticated`) —
// both the admin settings screen and the player wallet page need this.
// Mirrors lib/settings/registration.ts's getRegistrationEnabled().
export async function getPaymentMethods(): Promise<PaymentMethodRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("payment_methods")
    .select("method, enabled, destination, instructions")
    .order("method");

  return data ?? [];
}
