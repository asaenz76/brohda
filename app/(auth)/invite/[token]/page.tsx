import { lookupInvitation } from "@/lib/actions/invitations";
import { AcceptInvitationForm } from "./accept-invitation-form";
import { Card, CardContent } from "@/components/ui/card";

const STATUS_COPY: Record<string, string> = {
  invalid: "This invitation link isn't valid.",
  expired: "This invitation has expired. Ask your admin for a new one.",
  accepted: "This invitation has already been used. Try logging in instead.",
  revoked: "This invitation was revoked. Ask your admin for a new one.",
  rate_limited: "Too many attempts — wait a few minutes and try this link again.",
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await lookupInvitation(token);

  if (invitation.status !== "valid") {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm text-text-secondary">
          {STATUS_COPY[invitation.status]}
        </CardContent>
      </Card>
    );
  }

  return <AcceptInvitationForm token={token} email={invitation.email} />;
}
