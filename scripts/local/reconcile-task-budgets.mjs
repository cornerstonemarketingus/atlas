#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformTaskStore } from "../../apps/local-control/src/platform/task-store.mjs";
import { reconcileTaskBudgets } from "../../apps/local-control/src/platform/budget-reconciliation.mjs";
export function main(args = process.argv.slice(2)) {
  const options = {}; let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (["--database", "--tenant"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) { const key = args[i].slice(2); options[key] = args[++i]; }
    else throw new Error("Use --database <existing platform.sqlite> --tenant <tenant-id> [--apply]. Default is a dry run.");
  }
  if (!options.database || !options.tenant || !statSync(options.database).isFile()) throw new Error("An existing platform database and explicit tenant are required.");
  const inspection = new DatabaseSync(options.database, { readOnly: true });
  try {
    inspection.prepare("SELECT id,tenant_id,parent_task_id,usage_json FROM tasks LIMIT 0").all();
    inspection.prepare("SELECT seq,type,task_id,payload_json FROM events LIMIT 0").all();
  } finally { inspection.close(); }
  const store = new PlatformTaskStore(options.database);
  try { return reconcileTaskBudgets({ store, tenantId: options.tenant, apply }); }
  finally { store.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(), null, 2) + "\n"); }
  catch { process.stderr.write("Budget reconciliation failed. Verify the database, tenant and accounting consistency before retrying. No partial reconciliation was committed.\n"); process.exitCode = 1; }
}
