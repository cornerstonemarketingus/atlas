/**
 * The Worker configuration cloud environments need, added by vite.config.ts
 * only when apps/web/sandbox.config.json says "enabled": true. Disabled (the
 * default) the Worker is built exactly as before: no container, no Durable
 * Object class, no R2 bucket, so a deployment without the Workers Paid plan
 * still deploys, and the broker answers 503 UNAVAILABLE with the reason.
 *
 * Enabling it is one-way for the Durable Object class: once deployed with the
 * `v2-atlas-sandbox` migration, turning it off again needs a `deleted_classes`
 * migration (see docs/atlas-os/GENESIS.md).
 */
import { fileURLToPath } from "node:url";

// Absolute: the generated dist/server/wrangler.json does not rewrite relative image paths.
export const SANDBOX_DOCKERFILE = fileURLToPath(new URL("./Dockerfile", import.meta.url));

export const SANDBOX_MIGRATION = Object.freeze({ tag: "v2-atlas-sandbox", new_sqlite_classes: ["AtlasSandbox"] });

/** @param {{ enabled?: boolean, backupBucket?: string, previewDomain?: string | null }} settings */
export function sandboxEnabled(settings, environment = process.env) {
  if (environment.ATLAS_CLOUD_SANDBOX === "0") return false;
  return settings?.enabled === true || environment.ATLAS_CLOUD_SANDBOX === "1";
}

/** Merges the sandbox bindings into a Wrangler config object (returns a new object). */
export function withSandboxBindings(config, settings = {}) {
  const bucket = settings.backupBucket || "atlas-sandbox-backups";
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) throw new Error(`sandbox.config.json backupBucket is not a valid R2 bucket name: ${bucket}`);
  const previewDomain = settings.previewDomain ?? null;
  if (previewDomain !== null && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(previewDomain)) {
    throw new Error(`sandbox.config.json previewDomain is not a hostname: ${previewDomain}`);
  }
  return {
    ...config,
    main: "./worker/index-sandbox.ts",
    // The Sandbox SDK reads Linux error names through node:os. ctx.exports
    // (DirectoryBackupGateway) is on by default from compatibility date 2025-11-17.
    compatibility_flags: [...new Set([...(config.compatibility_flags ?? []), "nodejs_compat"])],
    containers: [
      ...(config.containers ?? []),
      { name: "atlas-sandbox", class_name: "AtlasSandbox", scheduling_policy: "durable_object", images: { atlas: { dockerfile: SANDBOX_DOCKERFILE } } },
    ],
    durable_objects: { bindings: [...(config.durable_objects?.bindings ?? []), { name: "ATLAS_SANDBOX", class_name: "AtlasSandbox" }] },
    migrations: [...(config.migrations ?? []), SANDBOX_MIGRATION],
    r2_buckets: [...(config.r2_buckets ?? []), { binding: "ATLAS_SANDBOX_BACKUPS", bucket_name: bucket }],
    ...(previewDomain ? { vars: { ...(config.vars ?? {}), ATLAS_SANDBOX_PREVIEW_DOMAIN: previewDomain } } : {}),
  };
}
