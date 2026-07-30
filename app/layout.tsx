import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono, Montserrat } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Brand logotype only ("brohda." in the header/auth screens) — not the
// general heading font, which stays Inter (--font-heading) everywhere else.
const montserrat = Montserrat({
  variable: "--font-logo",
  weight: "800",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: "brohda.",
  description: "Private, invite-only sports pools among friends.",
  // Belt-and-suspenders alongside app/robots.ts: invite-only means no page
  // should ever be indexed, even if a crawler ignores robots.txt.
  robots: { index: false, follow: false },
  // iOS has no install API at all (no beforeinstallprompt) — this is what
  // makes "Add to Home Screen" open the app full-screen, without Safari's
  // own chrome, once a visitor does that manually (see InstallAppButton).
  appleWebApp: { capable: true, statusBarStyle: "default", title: "brohda." },
  // Next.js 16's appleWebApp.capable stopped emitting the actual
  // apple-mobile-web-app-capable meta tag (checked its compiled output —
  // genuinely dropped, not a bug here) — that tag is still what makes
  // older iOS versions honor full-screen mode, so it's added directly
  // rather than relying solely on the manifest's display: "standalone".
  other: { "apple-mobile-web-app-capable": "yes" },
};

// Drives the browser chrome color (Android's status bar, Safari's tab bar)
// once installed to a home screen — matches globals.css's --accent-primary
// per theme, since the manifest's own theme_color can't vary by scheme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#4f46e5" },
    { media: "(prefers-color-scheme: dark)", color: "#6366f1" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} ${montserrat.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
