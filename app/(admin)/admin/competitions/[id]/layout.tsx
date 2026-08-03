import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { OPERATIONAL_STATUS_LABEL } from "@/lib/competitions/status";
import { IMPORT_STATUS_BADGE_CLASS, OPERATIONAL_STATUS_BADGE_CLASS } from "@/lib/competitions/badge-classes";
import { WorkspaceNav } from "./workspace-nav";
import { cn } from "@/lib/utils";

export default async function CompetitionWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireAdminOrAbove();
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/competitions" className="text-xs text-text-muted hover:underline">
          ← Competitions
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-text-primary">{data.name}</h1>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", IMPORT_STATUS_BADGE_CLASS[data.importStatus])}>
            {data.importStatus}
          </span>
          {data.operationalStatus && (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                OPERATIONAL_STATUS_BADGE_CLASS[data.operationalStatus],
              )}
            >
              {OPERATIONAL_STATUS_LABEL[data.operationalStatus]}
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted">
          {data.tier ? `Tier ${data.tier} · ` : ""}Season {data.season} · League ID {data.externalLeagueId}
        </p>
      </div>
      <WorkspaceNav id={id} />
      {children}
    </div>
  );
}
