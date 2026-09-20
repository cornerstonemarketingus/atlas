import { ComputerCenter } from "./ComputerCenter.js";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Computer operator — Atlas", description: "Give Atlas a browser mission. It researches and prepares autonomously, then pauses before consequential actions." };
export default function ComputerPage() { return <ComputerCenter />; }
