import type { Metadata } from "next";
import { AtlasGate } from "./AtlasGate.js";
import { ChatSection } from "./chat/ChatSection.js";

export const metadata: Metadata = {
  title: "Atlas — Autonomous software creation",
  description: "Build repositories, websites and apps with Atlas: an autonomous software platform with child agents, verified execution, computer control and persistent automation.",
};

export default function Home() {
  return <AtlasGate><ChatSection /></AtlasGate>;
}
