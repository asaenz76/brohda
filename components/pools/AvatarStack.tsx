import { Avatar } from "@/components/Avatar";

interface AvatarStackProps {
  participants: Array<{ displayName: string; avatarUrl: string | null }>;
  totalCount: number;
}

// X.5.6: social proof only — never reveals what anyone picked. A single
// numeric stat ("126 predicted") matching the mockup's engagement-row
// convention, replacing the earlier prose-sentence rendering so the whole
// app uses one visual language for this stat rather than two.
export function AvatarStack({ participants, totalCount }: AvatarStackProps) {
  if (totalCount === 0) {
    return <p className="text-xs text-text-secondary">Be the first friend to lock in.</p>;
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2" aria-hidden="true">
        {participants.slice(0, 3).map((p, i) => (
          <Avatar
            key={i}
            displayName={p.displayName}
            avatarUrl={p.avatarUrl}
            size="sm"
            className="ring-2 ring-surface-primary"
          />
        ))}
      </div>
      <p className="text-xs font-medium text-text-secondary">
        {totalCount} predicted
      </p>
    </div>
  );
}
