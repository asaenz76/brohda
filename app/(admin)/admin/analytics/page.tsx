import { requireSuperAdmin } from "@/lib/auth/session";
import { getAdminAnalyticsPageData } from "@/lib/analytics/adminAnalyticsService";
import type { DateRangePreset } from "@/lib/analytics/types";
import { AdminAnalyticsPageClient } from "./analytics-page-client";

const VALID_PRESETS: DateRangePreset[] = ["7D", "30D", "90D", "THIS_MONTH", "YTD", "ALL_TIME", "CUSTOM"];

function isValidPreset(value: string | undefined): value is DateRangePreset {
  return VALID_PRESETS.includes(value as DateRangePreset);
}

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range } = await searchParams;
  const preset: DateRangePreset = isValidPreset(range) ? range : "30D";

  await requireSuperAdmin();
  const data = await getAdminAnalyticsPageData({ preset });

  return <AdminAnalyticsPageClient data={data} preset={preset} />;
}
