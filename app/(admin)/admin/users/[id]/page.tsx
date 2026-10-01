import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Avatar } from "@/components/Avatar";
import { humanizeEnum } from "@/lib/utils/humanize";

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdminOrAbove();
  const supabase = await createClient();

  const { data: user } = await supabase
    .from("user_profiles")
    .select("id, display_name, username, avatar_url, role, is_active, created_at")
    .eq("id", id)
    .single();
  if (!user) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Avatar displayName={user.display_name} avatarUrl={user.avatar_url} size="lg" />
        <div>
          <h1 className="text-lg font-semibold text-text-primary">{user.display_name}</h1>
          {user.username && <p className="text-sm text-text-muted">@{user.username}</p>}
          <p className="text-xs text-text-secondary">
            {humanizeEnum(user.role)} · {user.is_active ? "Active" : "Inactive"}
          </p>
        </div>
      </div>

      <p className="text-sm">
        <Link href={`/profile/${user.username ?? user.id}`} className="text-accent-primary-label hover:underline">
          View public profile
        </Link>
      </p>
    </div>
  );
}
