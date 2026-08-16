import { redirect } from "next/navigation";

// Folded into the fixture-management list under Data Management as a
// filter (?archived=1) — see app/(admin)/admin/data/fixtures/page.tsx.
// Points straight there (not through /admin/fixtures) to avoid a double
// redirect now that /admin/fixtures itself redirects to /admin/events
// (Phase 4). Kept as a redirect, matching the same pattern already used
// for /my-picks -> /profile, for anything still bookmarked or deep-linked
// here.
export default function FixtureArchivePage() {
  redirect("/admin/data/fixtures?archived=1");
}
