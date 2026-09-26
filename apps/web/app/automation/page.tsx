import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { AutomationSection } from "./AutomationSection.js";

export const metadata: Metadata = {
  title: "Computer control — Atlas",
  description: "Browser tasks Atlas does on your computer, with approval before anything important.",
};

export default function AutomationPage() {
  return <AtlasGate><AutomationSection /></AtlasGate>;
}
