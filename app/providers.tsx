"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  // Registered site-wide (not just on the landing page) — an already-
  // installed visitor still benefits from it being present, and Chrome's
  // installability check for the "Get the app" button (InstallAppButton)
  // needs it regardless of which page first triggers beforeinstallprompt.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Unsupported/blocked — InstallAppButton simply won't get a
        // beforeinstallprompt event in that case, nothing else breaks.
      });
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
