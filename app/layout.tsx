import type { Metadata } from "next";
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
