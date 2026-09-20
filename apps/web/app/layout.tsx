import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./workspace.css";
import "./workspace-navigation.css";
import "./operator.css";
import "./operator-controls.css";
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
  title: "Atlas — The private AI operator",
  description: "Build software, operate your computer, and verify every consequential action with one private AI operator.",
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
    title: "Atlas — The private AI operator",
    description: "One persistent operator for software and computer work. Local-first, evidence-driven, and under your control.",
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
