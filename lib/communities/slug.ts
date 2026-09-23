// Pure, deterministic slugification for Community URLs (§31). Never used
// as identity itself (communities_subject_unique owns that) — only as a
// stable, human-readable route segment.
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
