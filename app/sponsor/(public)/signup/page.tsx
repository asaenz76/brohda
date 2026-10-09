import Link from "next/link";
import { SponsorSignupForm } from "./signup-form";
import { CURRENT_SPONSOR_TERMS } from "@/lib/sponsor/terms";

export const metadata = { title: "Become a Sponsor — brohda." };

// The dedicated Sponsor application: a business creating a Sponsor account. It is a separate product from Member registration — there is no "Member or
// Sponsor" switch anywhere, and this form never asks for anything a Member profile has.
export default function SponsorSignupPage() {
  return (
    <div className="space-y-4">
      <SponsorSignupForm terms={CURRENT_SPONSOR_TERMS} />
      <p className="text-center text-sm text-text-secondary">
        Already applied?{" "}
        <Link href="/sponsor/login" className="underline underline-offset-4">
          Sponsor log in
        </Link>
      </p>
    </div>
  );
}
