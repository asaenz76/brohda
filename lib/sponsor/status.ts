import type { SponsorStatus } from "@/lib/sponsorship/types";

export interface SponsorAccountStatusCopy {
  label: string;
  detail: string;
  /** Whether this Sponsor may browse paid inventory and submit sponsorships. */
  commercialAccess: boolean;
  /** Whether the Sponsor may still edit its profile. */
  canEditProfile: boolean;
}

// What a Sponsor ACCOUNT's status means to the person signed in as it. The account gate (this) is separate from approving any one sponsorship: ACTIVE
// lets a Sponsor start and submit sponsorships; each of those is still reviewed on its own.
export function sponsorAccountStatusCopy(status: SponsorStatus, reason: string | null): SponsorAccountStatusCopy {
  const why = reason ? ` Reason: ${reason}` : "";
  switch (status) {
    case "PENDING_REVIEW":
      return { label: "Application under review", detail: "Brohda is reviewing your application. You can finish your profile now; you'll be able to browse Games and start sponsorships once it's approved.", commercialAccess: false, canEditProfile: true };
    case "ACTIVE":
      return { label: "Approved", detail: "Your Sponsor account is active.", commercialAccess: true, canEditProfile: true };
    case "REJECTED":
      return { label: "Application not approved", detail: `Brohda couldn't approve this application.${why}`, commercialAccess: false, canEditProfile: false };
    case "SUSPENDED":
      return { label: "Account suspended", detail: `Brohda has paused this account. Existing sponsorships are listed below, but nothing new can be started or submitted.${why}`, commercialAccess: false, canEditProfile: false };
    case "DISABLED":
      return { label: "Account disabled", detail: `This account is no longer active.${why}`, commercialAccess: false, canEditProfile: false };
  }
}
