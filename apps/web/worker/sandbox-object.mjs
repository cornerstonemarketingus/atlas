import { DirectoryBackup, Files } from "@cloudflare/sandbox";
import { INACTIVITY_TIMEOUT_MS, createPreviewRegistry, createSandboxCore, handleSandboxObjectRequest } from "./sandbox-core.mjs";

// DirectoryBackup moves archives through this entrypoint; it must be exported from the Worker's main module.
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

/** The R2 binding that holds sandbox snapshots (see vite.config.ts). */
export const BACKUP_BINDING = "ATLAS_SANDBOX_BACKUPS";

/**
 * One Atlas cloud environment: a Durable Object that owns one Cloudflare
 * container (Sandbox SDK 1.0, `durable_object` scheduling policy). Only the
 * sandbox build includes it (worker/index-sandbox.ts, enabled in
 * sandbox.config.json); the broker route (app/api/sandbox) is its only caller.
 */
export class AtlasSandbox {
  #handlers;

  constructor(state, env) {
    const container = state.container ?? null;
    // The inactivity timeout does not survive a restart of the object (a deploy), so set it again.
    if (container?.running) void state.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    const backups = new Map();
    this.#handlers = {
      core: container
        ? createSandboxCore({
          container,
          files: new Files(container),
          // Each tenant's snapshots live under its own prefix: a record only restores with the prefix that made it.
          backupsFor: (tenant) => {
            const prefix = `tenants/${String(tenant).replace(/[^0-9a-z-]/gu, "")}/`;
            if (!backups.has(prefix)) backups.set(prefix, new DirectoryBackup(container, state.exports.DirectoryBackupGateway, { binding: BACKUP_BINDING, prefix }));
            return backups.get(prefix);
          },
          storage: state.storage,
          image: container.images?.atlas,
          previewDomain: env.ATLAS_SANDBOX_PREVIEW_DOMAIN || null,
        })
        : null,
      registry: createPreviewRegistry(state.storage),
    };
  }

  fetch(request) {
    return handleSandboxObjectRequest(this.#handlers, request);
  }
}
