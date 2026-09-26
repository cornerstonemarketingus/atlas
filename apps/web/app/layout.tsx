import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./workspace.css";
import "./atlas-shell.css";
import "./marketing.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Atlas — Build it. Run it. Grow it.",
  description: "Atlas is an autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  manifest: "/manifest.webmanifest",
  applicationName: "Atlas",
  themeColor: "#171a17",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Atlas" },
  formatDetection: { telephone: false },
  openGraph: {
    title: "Atlas — Build it. Run it. Grow it.",
    description: "An autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations — with you approving every consequential action.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
