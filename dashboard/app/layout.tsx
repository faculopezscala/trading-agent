import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const serif = Newsreader({ subsets: ["latin"], variable: "--font-serif", style: ["normal", "italic"] });

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Timberbot - un bot de IA tradeando solo, en vivo",
  description:
    "Dejé un bot de IA manejando plata real en Wallbit. Compite contra el S&P 500, contra Bitcoin (la Cartera Adorni) y contra un bot trucho que promete duplicar la plata cada mes. Gane o pierda, todo público.",
  openGraph: {
    title: "Timberbot - un bot de IA tradeando solo",
    description: "Mi bot vs el S&P 500, vs Bitcoin y vs el Bot Costiorto. En vivo.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Timberbot - un bot de IA tradeando solo",
    description: "Mi bot vs el S&P 500, vs Bitcoin y vs el Bot Costiorto. En vivo.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${inter.variable} ${mono.variable} ${serif.variable}`}>
      <body style={{ fontFamily: "var(--font-sans), system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
