import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { StreamProvider } from "@/lib/stream";
import { SolanaProviders } from "@/lib/wallet";
import { Nav } from "@/components/Nav";
import { Onboarding } from "@/components/Onboarding";
import { BallCursor } from "@/components/Cursor";
import { Mark } from "@/components/Mark";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  axes: ["wdth"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

/**
 * `metadataBase` resolves every RELATIVE og:image into an absolute URL. Pinned to
 * localhost, a shared receipt would advertise an image at http://localhost:3000
 * — which resolves to nothing on anyone else's machine, so the card renders
 * blank. Vercel exposes the deployment host as VERCEL_URL; NEXT_PUBLIC_SITE_URL
 * overrides it for a custom domain.
 */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
  "http://localhost:3000";

export const metadata: Metadata = {
  title: "Probo · every payout proven, not trusted",
  description:
    "Bet on the World Cup. Results verified cryptographically, winners paid on the spot, every payout comes with a receipt you can check.",
  metadataBase: new URL(SITE_URL),
  openGraph: {
    title: "Probo",
    description: "Every payout proven, not trusted. World Cup 2026.",
    images: ["/art-hero.jpg"],
  },
  other: { "theme-color": "#0f0d0a" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="flex min-h-screen flex-col bg-ink-950 text-ink-200">
        <SolanaProviders>
          <StreamProvider>
            <Nav />
            <Onboarding />
            <div className="flex-1">{children}</div>
            <footer className="rule mt-24">
              <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 lg:px-10">
                <span className="flex items-center gap-2.5 text-[12px] text-ink-500">
                  <Mark size={16} /> Probo
                </span>
                <span className="label !text-[10px] flex items-center gap-2 text-ink-400">
                  Powered by <span className="display-condensed text-[13px] tracking-[0.06em] text-ink-200">TxLINE</span>
                </span>
              </div>
            </footer>
            <BallCursor />
          </StreamProvider>
        </SolanaProviders>
      </body>
    </html>
  );
}
