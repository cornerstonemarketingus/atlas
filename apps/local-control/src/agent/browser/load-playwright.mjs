import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Finds Playwright for the daemon.
 *
 * The local control plane carries no third-party dependencies of its own, so
 * a bare `import("playwright-core")` from here only succeeds when some parent
 * folder happens to have it. The packages that do depend on it are Atlas's
 * own browser worker and Windows companion. Genesis's inspector already
 * looked in the browser worker; the agent's browser tools did not, so on a
 * machine where `npm install` had been run for the browser worker the command
 * center reported "playwright-core ready" while every browser tool answered
 * "Playwright is not installed". Both now use this one search:
 *
 *   1. a resolvable `playwright-core` (a parent node_modules, or a bundle)
 *   2. apps/browser-worker's dependency
 *   3. apps/windows-companion's dependency
 *
 * Returns the module (with `chromium`), or null when none is installed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const atlasRoot = resolve(here, "..", "..", "..", "..", "..");

export const PLAYWRIGHT_HOSTS = [join(atlasRoot, "apps", "browser-worker"), join(atlasRoot, "apps", "windows-companion")];

export async function loadPlaywright({ hosts = PLAYWRIGHT_HOSTS, importBare = () => import("playwright-core") } = {}) {
  const candidates = [
    importBare,
    ...hosts.map((host) => () => import(pathToFileURL(createRequire(join(host, "package.json")).resolve("playwright-core")).href)),
  ];
  for (const load of candidates) {
    try {
      const module = await load();
      // The CommonJS build arrives as { default: { chromium, … } } when imported by path.
      const engine = module?.chromium ? module : module?.default?.chromium ? module.default : null;
      if (engine) return engine;
    } catch { /* next */ }
  }
  return null;
}
