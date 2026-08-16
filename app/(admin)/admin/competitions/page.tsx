import { requireAdminOrAbove } from "@/lib/auth/session";
import { getCompetitionManagerDataAction } from "@/lib/actions/competitions";
import { CompetitionManager } from "./competition-manager";

export default async function AdminCompetitionsPage() {
  await requireAdminOrAbove();
  const result = await getCompetitionManagerDataAction();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Competitions</h1>
        <p className="text-sm text-text-muted">
          Discover, import, synchronize, and archive competitions — separate from creating pools.
        </p>
      </div>
      {result.success ? (
        <CompetitionManager initialData={result.data} />
      ) : (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          <p className="font-medium">{result.error}</p>
          <p className="mt-1 text-text-muted">Try reloading the page. If this keeps happening, check server logs.</p>
        </div>
      )}
    </div>
  );
}
