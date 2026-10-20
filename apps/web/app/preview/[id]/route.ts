import { getD1 } from "../../../db";
import { servePreview } from "../../api/genesis/hosted-preview.mjs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return servePreview({ id, database: getD1 });
}
