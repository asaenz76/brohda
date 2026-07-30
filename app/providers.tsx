"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  // We used to register an offline-caching service worker here. It caused
  // a real production incident: iOS suspends an installed home-screen app
  // across app-switches instead of reloading it, so a client left open
  // across a deploy kept running old JS whose Server Action IDs no longer
  // matched the server, hanging login indefinitely — compounded by iOS
  // Safari's service worker implementation adding real per-request latency
  // just from having any active service worker in scope. No longer worth
  // it for what was a nice-to-have. This actively unregisters any
  // service worker + clears any cache a returning visitor's browser still
  // has from before, rather than waiting on public/sw.js's own (slower,
  // update-cycle-dependent) self-unregistration to reach them.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
    if ("caches" in window) {
      caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
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
