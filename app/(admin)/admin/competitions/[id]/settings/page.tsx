import { notFound } from "next/navigation";
import { getCompetitionWorkspaceData } from "@/lib/competitions/workspace-data";
import { SettingsForm } from "./settings-form";

export default async function CompetitionSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCompetitionWorkspaceData(id);
  if (!data) notFound();

  const hasHistoricalImport = data.jobs.some((j) => j.includeHistorical && j.status === "SUCCEEDED");

  return (
    <SettingsForm
      leagueSeasonImportId={data.id}
      initialPoolCreationEnabled={data.poolCreationEnabled}
      hasHistoricalImport={hasHistoricalImport}
    />
  );
}
