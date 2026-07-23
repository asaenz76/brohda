"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

// Next.js only renders this for errors thrown by the root layout itself
// (Providers, fonts, etc.) — anywhere else, the nested app/(app)/error.tsx
// or app/(admin)/admin/error.tsx handles it instead. Since it replaces the
// root layout, it must define its own <html>/<body> and can't assume
// Providers (theme, etc.) rendered successfully.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          minHeight: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          padding: "2rem",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <p style={{ fontSize: "1rem", fontWeight: 600 }}>Something went wrong</p>
        <p style={{ maxWidth: "24rem", fontSize: "0.875rem", color: "#666" }}>
          The app hit an unexpected error. Try reloading the page.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            borderRadius: "0.5rem",
            border: "1px solid #ccc",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
