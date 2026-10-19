import { getD1 } from "../../../../db";
import { servePreview } from "../../../api/genesis/hosted-preview.mjs";

export async function GET(_request: Request, context: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await context.params;
  return servePreview({ id, file, database: getD1 });
}
