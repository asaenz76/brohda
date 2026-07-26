import { NextResponse } from "next/server";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { AVATAR_MAX_BYTES, AVATAR_OUTPUT_SIZE, detectImageMime } from "@/lib/validations/avatar";

export async function POST(request: Request) {
  const user = await requireUser();

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  if (file.size > AVATAR_MAX_BYTES) {
    return NextResponse.json({ error: "Image is too large (max 5MB)." }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedMime = detectImageMime(bytes);

  if (!detectedMime) {
    return NextResponse.json(
      { error: "Unsupported image type. Use JPEG, PNG, or WebP." },
      { status: 400 },
    );
  }

  let resized: Buffer;
  try {
    resized = await sharp(bytes)
      // Phone photos store raw sensor pixels plus an EXIF Orientation tag
      // saying how to rotate for display — .rotate() with no args reads
      // that tag and actually rotates the pixels before resize/crop math
      // runs. Without it, cover-fit crops the unrotated image and webp
      // re-encoding drops the tag entirely, leaving no way to recover the
      // correct orientation downstream.
      .rotate()
      .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: "cover" })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "Could not process this image." }, { status: 400 });
  }

  const admin = createAdminClient();
  const path = `${randomUUID()}.webp`;

  const { error: uploadError } = await admin.storage.from("avatars").upload(path, resized, {
    contentType: "image/webp",
    upsert: false,
  });

  if (uploadError) {
    return NextResponse.json({ error: "Could not upload image." }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = admin.storage.from("avatars").getPublicUrl(path);

  const { error: updateError } = await admin
    .from("user_profiles")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id);

  if (updateError) {
    return NextResponse.json({ error: "Could not save your new avatar." }, { status: 500 });
  }

  return NextResponse.json({ avatarUrl: publicUrl });
}
