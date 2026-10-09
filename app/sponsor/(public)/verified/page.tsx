import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { ScrubUrlHash } from "./scrub-url-hash";

// Where the verification link lands. The link has already confirmed the address by the time the browser gets here; this page signs nobody in and creates
// nothing — it just says so and points at the Sponsor log in.
export default function SponsorVerifiedPage() {
  return (
    <Card>
      <CardContent className="space-y-3 pt-6 text-center">
        <ScrubUrlHash />
        <h2 className="text-base font-semibold text-text-primary">Email verified</h2>
        <p className="text-sm text-text-secondary">Thanks — your business email is verified. Log in to finish your profile and see the status of your application.</p>
        <Link href="/sponsor/login?verified=1" className="inline-flex rounded-md bg-accent-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          Sponsor log in
        </Link>
      </CardContent>
    </Card>
  );
}
