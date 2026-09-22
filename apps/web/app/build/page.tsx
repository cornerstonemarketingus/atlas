import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { BuildSection } from "./BuildSection.js";

export const metadata: Metadata = {
  title: "Build — Atlas",
  description: "Describe a site, an app, or a change. Atlas reads the project, does the work, validates it, and opens a pull request.",
};

export default function BuildPage() {
  return <AtlasGate><BuildSection /></AtlasGate>;
}
