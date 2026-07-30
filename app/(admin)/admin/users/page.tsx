import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Avatar } from "@/components/Avatar";
import { formatCents } from "@/lib/utils/money";
import { humanizeEnum } from "@/lib/utils/humanize";
import { InviteForm } from "./invite-form";
import { CreateUserForm } from "./create-user-form";
import { ToggleActiveForm } from "./toggle-active-form";
import { WalletAdjustmentForm } from "./wallet-adjustment-form";
import { SetRoleForm } from "./set-role-form";
import { UsersFilters } from "./users-filters";
import { requireAdminOrAbove } from "@/lib/auth/session";

const PAGE_SIZE = 50;

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const { status: statusParam, page: pageParam } = await searchParams;
  // Test suites leave thousands of deactivated throwaway accounts behind —
  // defaulting to active-only keeps the common case fast and small; "all"/
  // "inactive" are one filter click away for the rare cleanup/audit visit.
  const status = statusParam === "inactive" || statusParam === "all" ? statusParam : "active";
  const page = Math.max(1, Number(pageParam) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();

  let usersQuery = supabase
    .from("user_profiles")
    .select("id, display_name, username, avatar_url, role, is_active, invited_by, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(from, to);
  if (status !== "all") {
    usersQuery = usersQuery.eq("is_active", status === "active");
  }
  // A plain 'admin' only manages the users they personally invited/created —
  // super_admin keeps seeing everyone, matching every other is_super_admin
  // vs is_admin_or_above split in this app (wallet visibility, role
  // management, etc.). Scoped here at the query level rather than in RLS:
  // select_all_profiles_as_admin is also relied on by admin/pools,
  // admin/pools/[id], and admin/wallet-requests to resolve arbitrary
  // users' display names, so narrowing that policy would break them.
  if (!isSuperAdmin) {
    usersQuery = usersQuery.eq("invited_by", viewer.id);
  }

  // wallet_balances' admin-read RLS policy stays super_admin-only (money
  // visibility), so there's no point querying it for a lower-privileged
  // 'admin' viewer — it would just come back empty.
  const [{ data: users, count }, { data: balances }] = await Promise.all([
    usersQuery,
    isSuperAdmin
      ? supabase.from("wallet_balances").select("user_id, balance").eq("account_type", "user")
      : Promise.resolve({ data: null }),
  ]);

  const balanceByUserId = new Map((balances ?? []).map((b) => [b.user_id, b.balance]));

  // "Created by" column — resolves each row's invited_by id to a display
  // name. Only fetched for ids actually present on this page.
  const ownerIds = [
    ...new Set((users ?? []).map((u) => u.invited_by).filter((id): id is string => id != null)),
  ];
  const pageUserIds = (users ?? []).map((u) => u.id);

  const [{ data: owners }, { data: activeEntries }] = await Promise.all([
    ownerIds.length > 0
      ? supabase.from("user_profiles").select("id, display_name").in("id", ownerIds)
      : Promise.resolve({ data: [] }),
    // "Pending" column — money still at risk in pools that haven't settled
    // yet. Fetched alongside wallet_balances, same super_admin-only gating
    // (this is money visibility, same as Balance). Filtered to ACTIVE here
    // (a plain column on entries, safe to filter server-side); OPEN/LOCKED
    // is checked in JS below since it's on the joined pools row, not
    // entries itself.
    isSuperAdmin && pageUserIds.length > 0
      ? supabase.from("entries").select("user_id, amount, pools(status)").eq("status", "ACTIVE").in("user_id", pageUserIds)
      : Promise.resolve({ data: null }),
  ]);
  const ownerNameById = new Map((owners ?? []).map((o) => [o.id, o.display_name]));

  const pendingByUserId = new Map<string, number>();
  for (const e of activeEntries ?? []) {
    // Without generated DB types, Supabase infers a to-one embed like this
    // as an array — actual shape at runtime is a single row, since each
    // entry belongs to exactly one pool.
    const poolsField = e.pools as unknown as { status: string } | { status: string }[] | null;
    const poolStatus = Array.isArray(poolsField) ? poolsField[0]?.status : poolsField?.status;
    if (poolStatus === "OPEN" || poolStatus === "LOCKED") {
      pendingByUserId.set(e.user_id, (pendingByUserId.get(e.user_id) ?? 0) + e.amount);
    }
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const statusQuery = status === "active" ? "" : `status=${status}&`;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Users</h1>
      <InviteForm />
      <CreateUserForm />
      <div className="flex items-center justify-between">
        <UsersFilters />
        <p className="text-xs text-text-muted">
          {count ?? 0} user{count === 1 ? "" : "s"}
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Created by</th>
              {isSuperAdmin && <th className="px-3 py-2 font-medium">Balance</th>}
              {isSuperAdmin && <th className="px-3 py-2 font-medium">Pending</th>}
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {(users ?? []).map((u) => {
              const balance = balanceByUserId.get(u.id) ?? 0;
              const pending = pendingByUserId.get(u.id) ?? 0;
              const isSelf = u.id === viewer.id;
              return (
                <tr key={u.id}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/profile/${u.username ?? u.id}`}
                      className="flex items-center gap-2 hover:underline"
                    >
                      <Avatar displayName={u.display_name} avatarUrl={u.avatar_url} size="sm" />
                      <div>
                        <div className="font-medium text-text-primary">{u.display_name}</div>
                        {u.username && <div className="text-xs text-text-muted">@{u.username}</div>}
                      </div>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{humanizeEnum(u.role)}</td>
                  <td className="px-3 py-2">
                    <span className={u.is_active ? "font-medium text-text-primary" : "text-text-muted"}>
                      {u.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">
                    {u.invited_by ? (ownerNameById.get(u.invited_by) ?? "Unknown") : "Self-registered"}
                  </td>
                  {isSuperAdmin && (
                    <td className="px-3 py-2 text-text-primary">{formatCents(balance)}</td>
                  )}
                  {isSuperAdmin && (
                    <td className="px-3 py-2 text-text-secondary">
                      {pending > 0 ? formatCents(pending) : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-end gap-2">
                      <Link href={`/admin/users/${u.id}`} className="text-xs text-text-secondary hover:underline">
                        Admin view
                      </Link>
                      {isSuperAdmin && (
                        <>
                          <WalletAdjustmentForm key={`${u.id}-${balance}`} userId={u.id} />
                          {!isSelf && (
                            <ToggleActiveForm
                              key={`${u.id}-${u.is_active}`}
                              userId={u.id}
                              isActive={u.is_active}
                            />
                          )}
                          {/* Promoting/demoting a super_admin stays a manual/
                              create-super-admin-script action, never this UI. */}
                          {!isSelf && u.role !== "super_admin" && (
                            <SetRoleForm
                              key={`${u.id}-${u.role}`}
                              userId={u.id}
                              role={u.role as "player" | "admin"}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Link
            href={`/admin/users?${statusQuery}page=${page - 1}`}
            aria-disabled={page <= 1}
            className={
              page <= 1
                ? "pointer-events-none text-text-muted opacity-50"
                : "text-text-primary hover:underline"
            }
          >
            Previous
          </Link>
          <span className="text-text-muted">
            Page {page} of {totalPages}
          </span>
          <Link
            href={`/admin/users?${statusQuery}page=${page + 1}`}
            aria-disabled={page >= totalPages}
            className={
              page >= totalPages
                ? "pointer-events-none text-text-muted opacity-50"
                : "text-text-primary hover:underline"
            }
          >
            Next
          </Link>
        </div>
      )}
    </div>
  );
}
