import type { Metadata } from "next";
import { AtlasGate } from "../AtlasGate.js";
import { AccountPrivacy } from "./AccountPrivacy.js";

export const metadata: Metadata = { title: "Settings — Atlas", description: "Manage your Atlas plan, privacy controls, and deletion request." };

export default function AccountPage() {
  return <AtlasGate><AccountPrivacy /></AtlasGate>;
}
