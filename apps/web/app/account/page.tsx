import { AccountPrivacy } from "./AccountPrivacy.js";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "Account and privacy — Atlas", description: "Manage your Atlas account, privacy controls, and deletion request." };
export default function AccountPage() { return <AccountPrivacy />; }
