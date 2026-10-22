import { handleMission } from "../runtime";
type Context = { params: Promise<{ missionId: string }> };
export async function GET(request: Request, context: Context) { return handleMission(request, (await context.params).missionId); }
export async function POST(request: Request, context: Context) { return handleMission(request, (await context.params).missionId); }
