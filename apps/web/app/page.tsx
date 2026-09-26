import type { Metadata } from "next";
import { AtlasGate } from "./AtlasGate.js";
import { ChatSection } from "./chat/ChatSection.js";

export const metadata: Metadata = {
  title: "Atlas — AI assistant that writes code and does browser work",
  description: "Chat with Atlas. It changes code in your GitHub projects through pull requests and does browser tasks on your computer, asking before anything important.",
};

export default function Home() {
  return <AtlasGate><ChatSection /></AtlasGate>;
}
