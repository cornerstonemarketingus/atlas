import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { SetupCenter } from "./SetupCenter.js";

export const metadata: Metadata = {
  title: "Connections — Atlas",
  description: "Bring your private Atlas deployment online and verify each production dependency from one control center.",
};

export default function SetupPage() {
  return <AtlasGate><SetupCenter /></AtlasGate>;
}
