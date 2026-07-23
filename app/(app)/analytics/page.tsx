import { requireUser } from "@/lib/auth/session";
import { getUserAnalyticsPageData } from "@/lib/analytics/userAnalyticsService";
import type { DateRangePreset } from "@/lib/analytics/types";
import { AnalyticsPageClient } from "./analytics-page-client";

const VALID_PRESETS: DateRangePreset[] = ["7D", "30D", "90D", "THIS_MONTH", "YTD", "ALL_TIME", "CUSTOM"];

function isValidPreset(value: string | undefined): value is DateRangePreset {
  return VALID_PRESETS.includes(value as DateRangePreset);
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range } = await searchParams;
  const preset: DateRangePreset = isValidPreset(range) ? range : "30D";

  const user = await requireUser();
  const data = await getUserAnalyticsPageData(user.id, { preset });

  return <AnalyticsPageClient data={data} preset={preset} />;
}
