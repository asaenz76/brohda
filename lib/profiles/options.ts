// Preset dropdown choices for the profile edit form's pronoun/gender
// fields — purely a UI convenience. The backing columns are free text
// (`user_profiles.pronouns` / `.gender`), so picking a preset just fills
// the same text input a "Custom" entry would; the server only enforces a
// length cap, not membership in this list.
export const PRONOUN_PRESETS = ["She/her", "He/him", "They/them", "She/they", "He/they"] as const;

export const GENDER_PRESETS = ["Female", "Male", "Non-binary", "Prefer not to say"] as const;
