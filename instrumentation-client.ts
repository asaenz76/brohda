import * as Sentry from "@sentry/nextjs";

// No-ops when NEXT_PUBLIC_SENTRY_DSN is unset — safe to leave wired up in
// local dev and CI, where no DSN is configured.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
