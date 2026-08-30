import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// The placeholder above only works for local Miniflare simulation. A real
// deploy needs the actual provisioned D1 database's id, supplied via env var
// (see .github/workflows/deploy-cloudflare.yml) since it can't be hardcoded.
// GitHub Actions sets an unconfigured secret to an empty string rather than
// leaving the env var unset, so an empty string must also fall through to
// the placeholder — hence `||`, not `??`.
const productionDatabaseId = process.env.ATLAS_D1_DATABASE_ID || undefined;
const productionDatabaseName = process.env.ATLAS_D1_DATABASE_NAME || undefined;

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // `vite dev` (command "serve") only ever talks to Miniflare's local D1
  // simulation, which accepts any id as a local key — the placeholder is
  // fine there. `vite build` (command "build") is also what CI runs before
  // a real `wrangler deploy`, and Cloudflare *does* validate that a bound
  // database_id actually exists in the account, rejecting the whole deploy
  // otherwise (confirmed: error 10181, "D1 binding 'DB' references database
  // ... which was not found"). So a production build must omit the binding
  // entirely rather than reference a fake id when no real one is configured
  // yet — degrading only the one route that needs D1, not the whole deploy.
  const d1DatabaseId = productionDatabaseId ?? (command === "serve" ? SITE_CREATOR_PLACEHOLDER_DATABASE_ID : undefined);

  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: d1 && d1DatabaseId
      ? [
          {
            binding: d1,
            database_name: productionDatabaseName ?? "site-creator-d1",
            database_id: d1DatabaseId,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
  };

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
