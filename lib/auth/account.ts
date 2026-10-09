import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { AccountType } from "./account-routing";

export interface AccountContext {
  userId: string;
  email: string | null;
  emailVerified: boolean;
  /** null = a login with no type (an unclassified legacy account): neither a Member nor a Sponsor. */
  accountType: AccountType | null;
}

/**
 * Who is signed in and what KIND of account they have. The type comes from the server-owned `account_types` table (RLS lets a user read only their own
 * row; nothing a client can write decides it — never user metadata). One lookup per render.
 */
export const getAccountContext = cache(async (): Promise<AccountContext | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("account_types").select("account_type").eq("user_id", user.id).maybeSingle();
  const type = data?.account_type;
  return { userId: user.id, email: user.email ?? null, emailVerified: Boolean(user.email_confirmed_at), accountType: type === "MEMBER" || type === "SPONSOR" ? type : null };
});
