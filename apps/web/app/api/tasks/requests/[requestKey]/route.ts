import { requestInspectionResponse } from "../../request-inspection-route.mjs";

export async function GET(request: Request, context: { params: Promise<{ requestKey: string }> }) {
  const { requestKey } = await context.params;
  return requestInspectionResponse(request, requestKey);
}
