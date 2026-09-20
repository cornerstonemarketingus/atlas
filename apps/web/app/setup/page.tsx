import { SetupCenter } from "./SetupCenter.js";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Setup center — Atlas", description: "Bring your private Atlas deployment online and verify each production dependency from one control center." };
export default function SetupPage() {
  return <SetupCenter />;
}
