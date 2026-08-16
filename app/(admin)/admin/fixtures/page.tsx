import { redirect } from "next/navigation";

// Phase 4 (spec §18): normal fixture browsing is now /admin/events —
// this route's everyday functionality (By date, By competition local
// browsing) is fully redundant with it. The two genuinely different
// concerns that lived here — "By fixture ID" provider lookup and the
// archived/imported-fixtures management list — moved to
// /admin/data/fixtures first (see that page), not deleted; this is a
// pure redirect, matching the same pattern already established for
// /admin/fixture-archive -> here. Kept (not deleted) for anything still
// bookmarked or deep-linked to this path, per spec §18's explicit "do
// not delete functionality merely to remove the route."
export default async function AdminFixturesRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  if (params.mode === "fixture-id" || params.archived === "1") {
    const target = new URLSearchParams();
    if (params.archived === "1") target.set("archived", "1");
    redirect(`/admin/data/fixtures${target.toString() ? `?${target.toString()}` : ""}`);
  }

  const target = new URLSearchParams();
  if (params.range) target.set("range", params.range);
  if (params.from) target.set("from", params.from);
  if (params.to) target.set("to", params.to);
  if (params.competition) target.set("competition", params.competition);
  redirect(`/admin/events${target.toString() ? `?${target.toString()}` : ""}`);
}
