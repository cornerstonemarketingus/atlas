#!/usr/bin/env node
/**
 * Launches the Atlas MCP server on stdio. The launcher decides who the caller
 * is, via environment:
 *   ATLAS_MCP_DB           path to the platform task-store SQLite file (required)
 *   ATLAS_MCP_TENANT       tenant id (required)
 *   ATLAS_MCP_USER         user id (required)
 *   ATLAS_MCP_AGENT        agent id (optional)
 *   ATLAS_MCP_PERMISSIONS  comma-separated granted permissions, e.g. "atlas.*"
 *   ATLAS_MCP_POLICY       path to a policy JSON document (default: empty rule set)
 *   ATLAS_MCP_AUDIT        path of a JSONL audit log (optional)
 */
import { appendFileSync, readFileSync } from "node:fs";

import { PlatformTaskStore } from "../task-store.mjs";
import { PolicyEngine } from "../policy.mjs";
import { AtlasMcpServer } from "./server.mjs";
import { serveStdio } from "./stdio.mjs";

const env = process.env;
for (const name of ["ATLAS_MCP_DB", "ATLAS_MCP_TENANT", "ATLAS_MCP_USER"]) {
  if (!env[name]) { process.stderr.write(`${name} is required\n`); process.exit(2); }
}
const policyDocument = env.ATLAS_MCP_POLICY ? JSON.parse(readFileSync(env.ATLAS_MCP_POLICY, "utf8")) : { version: "atlas-mcp.default", rules: [] };
const store = new PlatformTaskStore(env.ATLAS_MCP_DB);
const audit = env.ATLAS_MCP_AUDIT ? (event) => appendFileSync(env.ATLAS_MCP_AUDIT, `${JSON.stringify(event)}\n`) : () => {};
const server = new AtlasMcpServer({ store, policy: new PolicyEngine(policyDocument), audit });
const principal = {
  tenantId: env.ATLAS_MCP_TENANT,
  userId: env.ATLAS_MCP_USER,
  agentId: env.ATLAS_MCP_AGENT || null,
  grantedPermissions: (env.ATLAS_MCP_PERMISSIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};
const handle = serveStdio({ server, principal });
handle.closed.then(() => { store.close(); process.exit(0); });
