import type { Metadata } from "next";
import { AtlasDashboard } from "./AtlasDashboard";

export const metadata: Metadata = {
  title: "Atlas — Build what you're imagining",
  description: "Build, investigate, and operate software with a private AI workspace.",
};

export default function Home() {
  return <AtlasDashboard />;
}
