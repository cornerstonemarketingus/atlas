import { handleMission } from "./runtime";
export async function GET(request: Request) { return handleMission(request); }
export async function POST(request: Request) { return handleMission(request); }
