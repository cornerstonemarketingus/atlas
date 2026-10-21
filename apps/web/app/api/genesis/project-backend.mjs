import { createHostedSite, resultFromRow } from "./hosted-site.mjs";

/**
 * One place that decides who builds a new project.
 *
 * 1. A connected Genesis node (owner only) builds anything and can publish a
 *    repository, so it is used first when it is configured and answers.
 * 2. Otherwise the hosted builder makes a business website entirely inside the
 *    Worker: specification, pages, structural verification and a preview link.
 *    It needs no outside key and runs no generated code.
 * 3. Apps and APIs need the node; without one the person gets the node's own
 *    reason and fix, not a substitute.
 *
 * @param {{ bridge: { available?: boolean, create: Function, status: Function }, hosted?: { store: object, scope: { tenantId: number, principal: string } } | null, userMessage?: string }} options
 */
export function projectBackend({ bridge, hosted = null, userMessage = "" }) {
  return {
    hostedAvailable: Boolean(hosted),
    create: async (input) => {
      let nodeResult = null;
      if (bridge.available !== false) {
        nodeResult = await bridge.create(input);
        if (nodeResult.status !== "unavailable") return nodeResult;
      }
      if (!hosted) return nodeResult ?? bridge.create(input);
      const built = await createHostedSite({ store: hosted.store, scope: hosted.scope, requestId: input?.requestId, userMessage, input });
      // An app or API the hosted builder cannot make: report why the node could not, which is what fixes it.
      if (built.status === "failed" && built.code === "UNSUPPORTED_HOSTED_PROJECT") return nodeResult ?? (await bridge.create(input));
      return built;
    },
    status: async (id) => {
      if (typeof id === "string" && id.startsWith("gen_")) {
        if (!hosted) return { status: "not-found", message: "No project operation with that id." };
        try {
          const row = await hosted.store.get(hosted.scope, id);
          return row ? resultFromRow(row) : { status: "not-found", message: "No project operation with that id." };
        } catch { return { status: "unavailable", reason: "storage_not_ready", message: "Project status could not be read. No completion is confirmed." }; }
      }
      return bridge.status(id);
    },
  };
}
