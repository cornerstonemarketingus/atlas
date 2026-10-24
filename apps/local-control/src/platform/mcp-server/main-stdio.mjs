#!/usr/bin/env node
/**
 * Launches the Atlas MCP server on stdio. The launcher decides who the caller
 * is, via environment:
 *   ATLAS_MCP_DB           path to the platform task-store SQLite file (required;
 *                          must already exist unless ATLAS_MCP_CREATE_DB=1)
 *   ATLAS_MCP_CREATE_DB    "1" to create ATLAS_MCP_DB when it does not exist
 *   ATLAS_MCP_TENANT       tenant id (required)
 *   ATLAS_MCP_USER         user id (required)
 *   ATLAS_MCP_AGENT        agent id (optional)
 *   ATLAS_MCP_PERMISSIONS  comma-separated granted permissions, e.g. "atlas.*"
 *   ATLAS_MCP_POLICY       path to a policy JSON document (default: empty rule set)
 *   ATLAS_MCP_AUDIT        path of a JSONL audit log (optional)
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { PlatformTaskStore } from "../task-store.mjs";
import { PolicyEngine } from "../policy.mjs";
import { AtlasMcpServer } from "./server.mjs";
import { serveStdio } from "./stdio.mjs";

const env = process.env;
for (const name of ["ATLAS_MCP_DB", "ATLAS_MCP_TENANT", "ATLAS_MCP_USER"]) {
  if (!env[name]) { process.stderr.write(`${name} is required\n`); process.exit(2); }
}
// SQLite creates a missing file silently, so a mistyped path would serve an
// empty store that looks like "no tasks". Creating one must be asked for.
if (!existsSync(env.ATLAS_MCP_DB) && env.ATLAS_MCP_CREATE_DB !== "1") {
  process.stderr.write(`ATLAS_MCP_DB does not exist: ${env.ATLAS_MCP_DB}\nCheck the path (the daemon's store is platform.sqlite in its data directory, ~/.atlas by default), or set ATLAS_MCP_CREATE_DB=1 to create an empty store there.\n`);
  process.exit(2);
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
