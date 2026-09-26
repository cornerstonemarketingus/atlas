import { DatabaseSync } from "node:sqlite";

import { AgentFamilyRegistry, PEER_ORGANIZATIONS, seedFamilies } from "../family/index.mjs";
import { LOCAL_TENANT_ID } from "../dashboard.mjs";
import { InnovationPipeline } from "./pipeline.mjs";

/**
 * Brings the agent organization and the innovation pipeline up inside the
 * local daemon: a durable family graph (seeded once, policy-checked), and a
 * pipeline whose human decisions surface in the existing approvals inbox as
 * digest-bound "innovation.build" approvals.
 *
 * @param {object} options
 * @param {string} options.filename sqlite file for the family graph and innovation tables
 * @param {import("../../store.mjs").LocalTaskStore} options.store local approvals inbox + audit
 * @param {import("../task-store.mjs").PlatformTaskStore|null} [options.platformStore]
 */
export function bootstrapInnovation({ filename, store, platformStore = null, policy = {}, tenantId = LOCAL_TENANT_ID }) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const registry = new AgentFamilyRegistry(db);
  const { rootId, agents } = seedFamilies(registry, tenantId);
  const approvals = {
    request: ({ opportunityId, packetDigest, summary }) => store.createApproval({ capability: "innovation.build", summary: `${summary} [${opportunityId}]`, actionDigest: packetDigest }),
    resolve: ({ approvalId, approved }) => {
      store.decideApproval(approvalId, approved ? "approved" : "denied");
      if (approved) store.consumeApprovedDigest(store.approval(approvalId)?.actionDigest);
    },
  };
  const pipeline = new InnovationPipeline({ registry, platformStore, approvals, policy });
  const organization = (tenant) => ({
    tree: tenant === tenantId ? registry.familyTree(tenant, rootId) : null,
    executives: { businessDevelopment: agents["Business Development Executive"], product: agents["Product Executive"] },
    peers: PEER_ORGANIZATIONS.map((p) => ({ ...p, agentId: agents[p.parent] ?? null })),
  });
  return { registry, pipeline, organization, agents, rootId, close: () => db.close() };
}
