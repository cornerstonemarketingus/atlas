import type { Metadata } from "next";
import { AtlasGate } from "./AtlasGate.js";
import { ChatSection } from "./chat/ChatSection.js";

export const metadata: Metadata = {
  title: "Atlas — Build it. Run it. Grow it.",
  description: "Atlas is an autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations.",
};

export default function Home() {
  return <AtlasGate><ChatSection /></AtlasGate>;
}
