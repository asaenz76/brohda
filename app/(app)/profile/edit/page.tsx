import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { AvatarUploader } from "../avatar-uploader";
import { ProfileForm } from "../profile-form";
import { ChangePasswordForm } from "../change-password-form";
import { CloseAccountForm } from "../close-account-form";
import { getConsumerMonetaryAccess } from "@/lib/monetary/capability";

/**
 * Phase F (Brohda 2.0 redesign, spec §19) — "Edit profile" moved out of
 * the Profile tab row (it was a peer tab next to Predictions before; it
 * reads as account settings, not a social-identity surface someone else
 * would ever see) into its own conventional page, reached via a header
 * action button on your own Profile only. Reuses the exact same
 * AvatarUploader/ProfileForm/ChangePasswordForm/CloseAccountForm this
 * content already used — no account-management rewrite, only relocation.
 */
export default async function EditProfilePage() {
  const user = await requireUser();
  const supabase = await createClient();
  const moneyAccess = await getConsumerMonetaryAccess(user);

  const { data: editableFields } = await supabase
    .from("user_profiles")
    .select("pronouns, gender, bio, show_pronouns, show_gender, show_bio")
    .eq("id", user.id)
    .single();

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold text-text-primary">Edit profile</h1>

      <Card>
        <CardContent className="pt-6">
          <AvatarUploader displayName={user.display_name} avatarUrl={user.avatar_url} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <ProfileForm
            key={`${user.display_name}-${user.username}-${editableFields?.bio}`}
            displayName={user.display_name}
            username={user.username}
            pronouns={editableFields?.pronouns ?? null}
            gender={editableFields?.gender ?? null}
            bio={editableFields?.bio ?? null}
            showPronouns={editableFields?.show_pronouns ?? true}
            showGender={editableFields?.show_gender ?? true}
            showBio={editableFields?.show_bio ?? true}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <CloseAccountForm showMoney={moneyAccess.canSeeWallet} />
    </div>
  );
}
