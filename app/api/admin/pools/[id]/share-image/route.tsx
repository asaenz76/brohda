import { ImageResponse } from "next/og";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getMatchupSeparator, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";
import { SPORT_META, isEventSport } from "@/lib/fixtures/sport-meta";
import { loadShareImageFonts } from "@/lib/og/fonts";
import { SHARE_PALETTES } from "@/lib/og/theme";

// Exact platform crop sizes — not derived/responsive, since only these two
// concrete targets were asked for.
const DIMENSIONS = {
  instagram: { width: 1080, height: 1350 },
  facebook: { width: 1200, height: 630 },
} as const;

// Hand-tuned per platform rather than one fluid formula scaled off width —
// Instagram's tall 4:5 canvas and Facebook's short 1.9:1 one need
// genuinely different proportions, not just a smaller version of the same
// layout.
const LAYOUT = {
  instagram: {
    padding: 72,
    leagueLogo: 56,
    leagueTextSize: 30,
    sportLabelSize: 22,
    teamLogo: 96,
    teamNameSize: 34,
    separatorSize: 26,
    dateTimeSize: 24,
    questionSize: 52,
    optionSize: 30,
    optionPadding: 28,
    gapLarge: 48,
    gapMedium: 28,
    gapSmall: 14,
    footerSize: 26,
  },
  facebook: {
    padding: 48,
    leagueLogo: 40,
    leagueTextSize: 22,
    sportLabelSize: 16,
    teamLogo: 64,
    teamNameSize: 24,
    separatorSize: 18,
    dateTimeSize: 17,
    questionSize: 34,
    optionSize: 22,
    optionPadding: 18,
    gapLarge: 24,
    gapMedium: 16,
    gapSmall: 8,
    footerSize: 18,
  },
} as const;

function toAbsoluteUrl(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith("/") ? `${process.env.APP_URL}${url}` : url;
}

function formatKickoff(iso: string): string {
  const date = new Date(iso);
  const datePart = new Intl.DateTimeFormat("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }).format(
    date,
  );
  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `${datePart} · ${timePart}`;
}

function TeamLogo({ url, size }: { url: string | null; size: number }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: size / 2, objectFit: "contain" }}
    />
  ) : (
    <div style={{ display: "flex", width: size, height: size, borderRadius: size / 2, backgroundColor: "#d4d4d4" }} />
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Redirects (not a JSON 403) on failure, same as every other admin
  // surface in this app — acceptable here since these are always plain
  // <a href> downloads, never fetch()-driven.
  await requireSuperAdmin();

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") === "facebook" ? "facebook" : "instagram";
  const theme = searchParams.get("theme") === "dark" ? "dark" : "light";

  const supabase = await createClient();
  const { data: pool } = await supabase
    .from("pools")
    .select(
      "id, question, pool_type, fixtures(sport, competition_name, competition_country, competition_logo_url, home_team_name, home_team_logo_url, away_team_name, away_team_logo_url, scheduled_start_utc)",
    )
    .eq("id", id)
    .single();

  if (!pool) return new Response("Not found", { status: 404 });

  const { data: options } = await supabase
    .from("pool_options_public")
    .select("label")
    .eq("pool_id", id)
    .order("sort_order");

  const fixture = Array.isArray(pool.fixtures) ? pool.fixtures[0] : pool.fixtures;
  const { width, height } = DIMENSIONS[platform];
  const L = LAYOUT[platform];
  const palette = SHARE_PALETTES[theme];

  const leagueLabel = fixture?.competition_name
    ? fixture.competition_country
      ? `${fixture.competition_country} | ${fixture.competition_name}`
      : fixture.competition_name
    : pool.pool_type === "COMBO"
      ? "Combo"
      : "Custom Poll";

  const sportLabel = fixture?.sport && isEventSport(fixture.sport) ? SPORT_META[fixture.sport].label : null;

  const hasMatchup = !!(fixture?.home_team_name && fixture?.away_team_name);
  const [first, second] = hasMatchup
    ? orderTeamsForDisplay(
        fixture!.sport,
        { name: fixture!.home_team_name, logoUrl: toAbsoluteUrl(fixture!.home_team_logo_url) },
        { name: fixture!.away_team_name, logoUrl: toAbsoluteUrl(fixture!.away_team_logo_url) },
      )
    : [null, null];

  const fonts = await loadShareImageFonts();

  const image = new ImageResponse(
    (
      <div
        style={{
          width,
          height,
          display: "flex",
          flexDirection: "column",
          backgroundColor: palette.surfacePrimary,
          padding: L.padding,
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: L.gapSmall }}>
          <TeamLogo url={toAbsoluteUrl(fixture?.competition_logo_url ?? null)} size={L.leagueLogo} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: L.leagueTextSize, fontWeight: 600, color: palette.textPrimary }}>
              {leagueLabel}
            </span>
            {sportLabel && (
              <span style={{ fontSize: L.sportLabelSize, color: palette.textMuted }}>{sportLabel}</span>
            )}
          </div>
        </div>

        {hasMatchup && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              marginTop: L.gapLarge,
              gap: L.gapMedium,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: L.gapMedium,
                width: "100%",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: L.gapSmall,
                  flex: 1,
                }}
              >
                <TeamLogo url={first!.logoUrl} size={L.teamLogo} />
                <span
                  style={{
                    fontSize: L.teamNameSize,
                    fontWeight: 700,
                    color: palette.textPrimary,
                    textAlign: "center",
                  }}
                >
                  {first!.name}
                </span>
              </div>
              <span style={{ fontSize: L.separatorSize, fontWeight: 700, color: palette.textMuted }}>
                {getMatchupSeparator(fixture!.sport).toUpperCase()}
              </span>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: L.gapSmall,
                  flex: 1,
                }}
              >
                <TeamLogo url={second!.logoUrl} size={L.teamLogo} />
                <span
                  style={{
                    fontSize: L.teamNameSize,
                    fontWeight: 700,
                    color: palette.textPrimary,
                    textAlign: "center",
                  }}
                >
                  {second!.name}
                </span>
              </div>
            </div>
            <span style={{ fontSize: L.dateTimeSize, color: palette.textMuted }}>
              {formatKickoff(fixture!.scheduled_start_utc)}
            </span>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: 1,
            marginTop: L.gapLarge,
            marginBottom: L.gapLarge,
          }}
        >
          <span style={{ fontSize: L.questionSize, fontWeight: 700, color: palette.textPrimary, lineHeight: 1.15 }}>
            {pool.question}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: L.gapSmall }}>
          {(options ?? []).map((option) => (
            <div
              key={option.label}
              style={{
                display: "flex",
                padding: L.optionPadding,
                borderRadius: 16,
                border: `2px solid ${palette.borderSubtle}`,
              }}
            >
              <span style={{ fontSize: L.optionSize, fontWeight: 600, color: palette.textPrimary }}>
                {option.label}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "center", marginTop: L.gapMedium }}>
          <span style={{ fontSize: L.footerSize, fontWeight: 700, color: palette.textMuted }}>brohda.com</span>
        </div>
      </div>
    ),
    {
      width,
      height,
      fonts,
      headers: {
        "Content-Disposition": `attachment; filename="pool-${id}-${platform}-${theme}.png"`,
      },
    },
  );

  return image;
}
