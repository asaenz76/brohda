import { redirect } from "next/navigation";

// Folded into /admin/fixtures as a filter (?archived=1) — launch
// simplification, one fewer admin destination for the same underlying list
// (see app/(admin)/admin/fixtures/page.tsx). Kept as a redirect, matching
// the same pattern already used for /my-picks -> /profile, for anything
// still bookmarked or deep-linked here.
export default function FixtureArchivePage() {
  redirect("/admin/fixtures?archived=1");
}
