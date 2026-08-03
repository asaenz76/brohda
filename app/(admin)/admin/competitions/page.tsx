import { requireAdminOrAbove } from "@/lib/auth/session";
import { getCompetitionManagerDataAction } from "@/lib/actions/competitions";
import { CompetitionManager } from "./competition-manager";

export default async function AdminCompetitionsPage() {
  await requireAdminOrAbove();
  const data = await getCompetitionManagerDataAction();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Competitions</h1>
        <p className="text-sm text-text-muted">
          Discover, import, synchronize, and archive competitions — separate from creating pools.
        </p>
      </div>
      <CompetitionManager initialData={data} />
    </div>
  );
}
