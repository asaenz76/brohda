import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseParsedUrl = supabaseUrl ? new URL(supabaseUrl) : undefined;
const supabaseHostname = supabaseParsedUrl?.hostname;
// CSP connect-src matches WebSocket connections by scheme too — listing
// only the http(s):// origin doesn't cover the ws(s):// Realtime endpoint
// Supabase's client opens from it, so the browser throws a SecurityError
// ("The operation is insecure") the instant a channel tries to connect.
// Mirrors the Supabase URL's own scheme (wss for the hosted https project,
// ws for local dev's http://127.0.0.1:54321).
const supabaseWsOrigin = supabaseHostname
  ? `${supabaseParsedUrl!.protocol === "https:" ? "wss" : "ws"}://${supabaseHostname}`
  : "";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: supabaseHostname
      ? [
          {
            protocol: "https",
            hostname: supabaseHostname,
            pathname: "/storage/v1/object/public/**",
          },
          {
            protocol: "http",
            hostname: "127.0.0.1",
            pathname: "/storage/v1/object/public/**",
          },
        ]
      : [],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // React dev mode needs eval() for HMR/error-overlay stack rebuilding.
              `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
              // Split element- vs attribute-level style enforcement: this
              // blocks an attacker-injected <style>/<link> stylesheet (a
              // real CSS-exfiltration vector) while still allowing the
              // handful of legitimate, hardcoded dynamic style={{}} usages
              // in this codebase (drag-slider position in SlideToConfirm,
              // percentage bar width in PoolDistributionBar) — there's no
              // nonce mechanism for inline style *attributes* driven by
              // continuously-variable values, so removing unsafe-inline
              // there entirely would require rewriting those to a CSSOM/
              // stylesheet-based approach. Browsers that don't understand
              // style-src-elem/-attr fall back to the plain style-src
              // below, matching today's behavior exactly (no regression).
              "style-src 'self' 'unsafe-inline'",
              "style-src-elem 'self'",
              "style-src-attr 'unsafe-inline'",
              "img-src 'self' data: https: http://127.0.0.1:*",
              "font-src 'self' data:",
              // https://*.sentry.io/https://*.ingest.*.sentry.io covers both
              // the SaaS ingest endpoints and self-hosted-style project
              // DSNs — harmless to include even before a DSN is configured,
              // since the SDK sends nothing without one.
              `connect-src 'self' ${supabaseUrl ?? ""} ${supabaseWsOrigin} https://*.sentry.io https://*.ingest.sentry.io${process.env.NODE_ENV !== "production" ? " ws://localhost:* http://localhost:*" : ""}`,
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Only meaningful once org/project/authToken are set (source-map upload
  // for readable stack traces); silently no-ops otherwise.
  silent: true,
  widenClientFileUpload: true,
  webpack: {
    treeshake: { removeDebugLogging: true },
  },
  telemetry: false,
});
