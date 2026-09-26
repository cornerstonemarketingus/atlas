import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { AutomationSection } from "../automation/AutomationSection.js";

// Kept as an alias of /automation: the Windows companion's setup instructions,
// the marketing navigation, and the owner sign-in redirect all point here.
export const metadata: Metadata = {
  title: "Computer — Atlas",
  description: "Browser tasks Atlas does on your computer, with approval before anything important.",
};

export default function ComputerPage() {
  return <AtlasGate><AutomationSection /></AtlasGate>;
}
