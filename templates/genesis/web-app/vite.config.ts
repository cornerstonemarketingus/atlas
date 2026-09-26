import vinext from "vinext";
import { defineConfig } from "vite";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const productionDatabaseId = process.env.ATLAS_D1_DATABASE_ID || undefined;
const productionDatabaseName = process.env.ATLAS_D1_DATABASE_NAME || undefined;

export default defineConfig(async ({ command }) => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const d1DatabaseId = productionDatabaseId ?? (command === "serve" ? SITE_CREATOR_PLACEHOLDER_DATABASE_ID : undefined);
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          main: "./worker/index.ts",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: d1DatabaseId ? [{ binding: "DB", database_name: productionDatabaseName ?? "atlas-genesis", database_id: d1DatabaseId }] : [],
        },
      }),
    ],
  };
});
