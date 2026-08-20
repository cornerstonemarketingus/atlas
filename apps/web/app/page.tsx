import type { Metadata } from "next";
import { AtlasDashboard } from "./AtlasDashboard";

export const metadata: Metadata = {
  title: "Atlas — Autonomous engineering control plane",
  description: "Plan, approve, validate, and ship repository changes with Atlas.",
};

export default function Home() {
  return <AtlasDashboard />;
}
