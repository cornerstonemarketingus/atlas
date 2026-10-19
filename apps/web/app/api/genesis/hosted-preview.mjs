import { getHostedSiteForPreview } from "../../../db/hosted-sites.mjs";
import { PREVIEW_ID, previewHeaders, renderPreviewFile } from "./hosted-site.mjs";

/**
 * GET /preview/<id>[/<file>]. Opens without signing in: the id is an unguessable
 * capability, every response is no-store, noindex and CSP-sandboxed, and a
 * missing, malformed or non-hosted id is the same plain 404.
 * @param {{ id: string, file?: string, database: () => unknown }} input
 */
export async function servePreview({ id, file = "", database }) {
  const missing = () => new Response("Not found.\n", { status: 404, headers: previewHeaders("text/plain; charset=utf-8") });
  if (!PREVIEW_ID.test(id)) return missing();
  let row;
  try { row = await getHostedSiteForPreview(database(), id); } catch { return new Response("Previews are temporarily unavailable.\n", { status: 503, headers: previewHeaders("text/plain; charset=utf-8") }); }
  const page = renderPreviewFile(row, file);
  return new Response(page.body, { status: page.status, headers: page.headers });
}
