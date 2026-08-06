import { Avatar } from "@/components/Avatar";

interface AvatarStackProps {
  participants: Array<{ displayName: string; avatarUrl: string | null }>;
  totalCount: number;
}

// X.5.6: social proof only — never reveals what anyone picked. A single
// numeric stat ("126 predicted") matching the mockup's engagement-row
// convention, replacing the earlier prose-sentence rendering so the whole
// app uses one visual language for this stat rather than two.
//
// Promoted a notch from its original text-xs (Phase 2 hierarchy pass) but
// deliberately kept below the weight of the question/option-button text —
// this is social context around the pick, not the pick itself, so
// font-medium/text-secondary here, not font-semibold/text-primary.
export function AvatarStack({ participants, totalCount }: AvatarStackProps) {
  if (totalCount === 0) {
    return <p className="text-sm font-medium text-text-secondary">Be the first friend to lock in.</p>;
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
      <p className="text-sm font-medium text-text-secondary">
        {totalCount} predicted
      </p>
    </div>
  );
}
