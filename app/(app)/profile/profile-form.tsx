"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateProfileAction, type UpdateProfileState } from "@/lib/actions/profile";
import { PRONOUN_PRESETS, GENDER_PRESETS } from "@/lib/profiles/options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

const initialState: UpdateProfileState = { error: null, success: false };

const BIO_MAX_LENGTH = 150;

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

// A single text input (the field actually submitted) paired with a preset
// dropdown as a fill-in shortcut — picking a preset just writes its value
// into the same input; typing anything else is the "Custom" case, no
// separate mode/state needed.
function PresetTextField({
  label,
  name,
  presets,
  initialValue,
  maxLength,
}: {
  label: string;
  name: string;
  presets: readonly string[];
  initialValue: string;
  maxLength: number;
}) {
  const [value, setValue] = useState(initialValue);
  const selectValue = value === "" ? "" : presets.includes(value) ? value : "Custom";

  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <select
        aria-label={`${label} presets`}
        className={SELECT_CLASS}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value !== "Custom") setValue(e.target.value);
        }}
      >
        <option value="">Not set</option>
        {presets.map((preset) => (
          <option key={preset} value={preset}>
            {preset}
          </option>
        ))}
        <option value="Custom">Custom</option>
      </select>
      <Input
        id={name}
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={maxLength}
        placeholder="Or type your own"
      />
    </div>
  );
}

export function ProfileForm({
  displayName,
  username,
  pronouns,
  gender,
  bio,
  showPronouns,
  showGender,
  showBio,
  emailNotificationsEnabled,
}: {
  displayName: string;
  username: string | null;
  pronouns: string | null;
  gender: string | null;
  bio: string | null;
  showPronouns: boolean;
  showGender: boolean;
  showBio: boolean;
  emailNotificationsEnabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateProfileAction, initialState);
  const [bioLength, setBioLength] = useState(bio?.length ?? 0);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="displayName">Display name</Label>
        <Input id="displayName" name="displayName" defaultValue={displayName} maxLength={60} required />
        <p className="text-xs text-text-secondary">Required — you can&apos;t use the rest of the site without it.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          name="username"
          defaultValue={username ?? ""}
          maxLength={24}
          minLength={3}
          pattern="[a-zA-Z0-9_]+"
          placeholder="Letters, numbers, or underscores"
          required
        />
        <p className="text-xs text-text-secondary">Required — you can&apos;t use the rest of the site without it.</p>
      </div>

      <PresetTextField
        label="Pronouns"
        name="pronouns"
        presets={PRONOUN_PRESETS}
        initialValue={pronouns ?? ""}
        maxLength={30}
      />
      <div className="flex items-center gap-2">
        <Checkbox id="showPronouns" name="showPronouns" defaultChecked={showPronouns} />
        <Label htmlFor="showPronouns" className="text-sm font-normal text-text-secondary">
          Show pronouns on my public profile
        </Label>
      </div>

      <PresetTextField
        label="Gender"
        name="gender"
        presets={GENDER_PRESETS}
        initialValue={gender ?? ""}
        maxLength={30}
      />
      <div className="flex items-center gap-2">
        <Checkbox id="showGender" name="showGender" defaultChecked={showGender} />
        <Label htmlFor="showGender" className="text-sm font-normal text-text-secondary">
          Show gender on my public profile
        </Label>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bio">Short bio</Label>
        <Textarea
          id="bio"
          name="bio"
          defaultValue={bio ?? ""}
          maxLength={BIO_MAX_LENGTH}
          rows={3}
          onChange={(e) => setBioLength(e.target.value.length)}
        />
        <p className="text-right text-xs text-text-muted">
          {bioLength}/{BIO_MAX_LENGTH}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="showBio" name="showBio" defaultChecked={showBio} />
        <Label htmlFor="showBio" className="text-sm font-normal text-text-secondary">
          Show bio on my public profile
        </Label>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="emailNotificationsEnabled"
          name="emailNotificationsEnabled"
          defaultChecked={emailNotificationsEnabled}
        />
        <Label htmlFor="emailNotificationsEnabled" className="text-sm font-normal text-text-secondary">
          Email me when a new pool is published
        </Label>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && <p className="text-sm font-medium text-text-primary">Profile updated.</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
