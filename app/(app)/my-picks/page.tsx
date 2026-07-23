import { redirect } from "next/navigation";

// My Picks moved into the Profile page's "Predictions" tab (Phase 3) —
// keep this route alive as a redirect for anything still deep-linking here.
export default function MyPicksPage() {
  redirect("/profile");
}
