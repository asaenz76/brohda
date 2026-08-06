import { redirect } from "next/navigation";

// Folded into the Dashboard as a collapsible section (Phase 7: Admin
// Cleanup — see app/(admin)/admin/competitions/[id]/page.tsx). Kept as a
// redirect, matching the same pattern already used for
// /admin/fixture-archive -> /admin/fixtures, for anything still bookmarked
// or deep-linked here. settings-form.tsx itself is untouched — still
// imported directly by the Dashboard.
export default async function CompetitionSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/competitions/${id}`);
}
