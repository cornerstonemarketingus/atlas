import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { AutomationSection } from "./AutomationSection.js";

export const metadata: Metadata = {
  title: "Automation — Atlas",
  description: "Give Atlas a browser mission. It researches and prepares autonomously, then pauses before consequential actions.",
};

export default function AutomationPage() {
  return <AtlasGate><AutomationSection /></AtlasGate>;
}
