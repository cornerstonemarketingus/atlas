import "./globals.css";

export const metadata = {
  title: "Atlas Genesis App",
  description: "A starter app created by Atlas.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
