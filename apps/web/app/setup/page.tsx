import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { SetupCenter } from "./SetupCenter.js";

export const metadata: Metadata = {
  title: "Connections — Atlas",
  description: "See what Atlas is connected to, what still needs setting up, and how far it may go on its own.",
};

export default function SetupPage() {
  return <AtlasGate><SetupCenter /></AtlasGate>;
}
