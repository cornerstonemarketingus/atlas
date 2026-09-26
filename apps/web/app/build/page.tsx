import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { BuildSection } from "./BuildSection.js";

export const metadata: Metadata = {
  title: "Projects — Atlas",
  description: "Pick a GitHub project and say what you want. Atlas makes the change or reports back, runs your tests, and opens a pull request.",
};

export default function BuildPage() {
  return <AtlasGate><BuildSection /></AtlasGate>;
}
