import type { Metadata } from "next";
import { AtlasGate } from "./AtlasGate.js";
import { ChatSection } from "./chat/ChatSection.js";

export const metadata: Metadata = {
  title: "Atlas — The private AI operator",
  description: "Give Atlas a software or computer mission. It builds, operates, verifies, and pauses before consequential actions.",
};

export default function Home() {
  return <AtlasGate><ChatSection /></AtlasGate>;
}
