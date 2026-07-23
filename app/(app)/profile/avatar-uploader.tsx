"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";

export function AvatarUploader({
  displayName,
  avatarUrl,
}: {
  displayName: string;
  avatarUrl: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setPending(true);
    setError(null);

    const formData = new FormData();
    formData.set("file", file);

    const response = await fetch("/api/avatar", { method: "POST", body: formData });
    const result = await response.json();

    setPending(false);
    e.target.value = "";

    if (!response.ok) {
      setError(result.error ?? "Could not upload image.");
      return;
    }

    router.refresh();
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <Avatar displayName={displayName} avatarUrl={avatarUrl} size="xl" />
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        {pending ? "Uploading…" : "Change photo"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
