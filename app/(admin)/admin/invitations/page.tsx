import { createClient } from "@/lib/supabase/server";
import { RevokeInvitationButton } from "./revoke-invitation-button";

const STATUS_STYLE: Record<string, string> = {
  pending: "text-text-secondary",
  accepted: "font-medium text-text-primary",
  expired: "text-text-muted",
  revoked: "text-danger",
};

export default async function AdminInvitationsPage() {
  const supabase = await createClient();
  const { data: invitations } = await supabase
    .from("invitations")
    .select("id, email, status, expires_at, created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Invitations</h1>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Expires</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {(invitations ?? []).map((inv) => (
            <tr key={inv.id}>
              <td className="px-3 py-2 text-text-primary">{inv.email}</td>
              <td className={`px-3 py-2 ${STATUS_STYLE[inv.status]}`}>{inv.status}</td>
              <td className="px-3 py-2 text-text-secondary">
                {new Date(inv.expires_at).toLocaleDateString()}
              </td>
              <td className="px-3 py-2 text-right">
                {inv.status === "pending" && <RevokeInvitationButton invitationId={inv.id} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
