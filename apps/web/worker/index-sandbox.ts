/**
 * The Worker entry point for a deployment with cloud environments enabled
 * (apps/web/sandbox.config.json → "enabled": true; vite.config.ts picks this
 * file then). Everything in index.ts, plus the sandbox Durable Object, the
 * backup gateway the Sandbox SDK needs, and preview-hostname routing.
 *
 * The default build (sandbox disabled) never imports this file, so a
 * deployment without the Workers Paid plan carries no container code.
 */
import worker from "./index";
import { routePreviewRequest } from "./sandbox-core.mjs";

export * from "./index";
export { AtlasSandbox, DirectoryBackupGateway } from "./sandbox-object.mjs";

type Environment = Record<string, unknown>;

const sandboxWorker = {
  async fetch(request: Request, env: Environment, ctx: Parameters<typeof worker.fetch>[2]): Promise<Response> {
    // Preview hostnames are their own origins and never reach the app's routes.
    const preview = await routePreviewRequest(request, env);
    if (preview) return preview;
    return worker.fetch(request, env as unknown as Parameters<typeof worker.fetch>[1], ctx);
  },
};

export default sandboxWorker;
