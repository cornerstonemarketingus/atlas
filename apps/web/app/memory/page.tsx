import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { MemorySection } from "./MemorySection.js";

export const metadata: Metadata = { title: "Memory — Atlas", description: "Review and edit Atlas's durable saved memories." };

export default function MemoryPage() {
  return <AtlasGate><MemorySection /></AtlasGate>;
}
