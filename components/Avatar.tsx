import Image from "next/image";
import { cn } from "@/lib/utils";
import { isAllowedAvatarHost } from "@/lib/utils/avatar";
import { getInitials } from "@/lib/utils/initials";

const SIZES = {
  sm: "size-6 text-xs",
  md: "size-8 text-sm",
  lg: "size-12 text-base",
  xl: "size-20 text-xl",
} as const;

export function Avatar({
  displayName,
  avatarUrl,
  size = "md",
  className,
}: {
  displayName: string;
  avatarUrl: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const pixelSize = { sm: 24, md: 32, lg: 48, xl: 80 }[size];

  if (avatarUrl && isAllowedAvatarHost(avatarUrl)) {
    return (
      <Image
        src={avatarUrl}
        alt={displayName}
        width={pixelSize}
        height={pixelSize}
        className={cn("rounded-full object-cover", SIZES[size], className)}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={displayName}
      className={cn(
        "flex items-center justify-center rounded-full bg-surface-elevated font-medium text-text-secondary",
        SIZES[size],
        className,
      )}
    >
      {getInitials(displayName)}
    </span>
  );
}
