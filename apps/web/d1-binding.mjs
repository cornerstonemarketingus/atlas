/**
 * The Worker's D1 binding, as written into the generated
 * dist/server/wrangler.json.
 *
 * `migrations_dir` names where the checked-in migrations actually live
 * (`drizzle/`, relative to this app). Without it Wrangler defaults to
 * `migrations/`, which does not exist, so `wrangler d1 migrations apply
 * <db> --local -c dist/server/wrangler.json` found nothing to apply. Only the
 * `wrangler d1 migrations` commands read this field: `wrangler deploy` and the
 * migrate-d1 / provision-d1 workflows (which run `wrangler d1 execute --file`
 * on explicit paths) are unaffected by it.
 */
export const D1_MIGRATIONS_DIR = "drizzle";

/**
 * @param {{ binding?: string | null, databaseId?: string, databaseName?: string }} options
 * @returns {Array<{ binding: string, database_name: string, database_id: string, migrations_dir: string }>}
 *   No binding at all when there is no binding name or database id: a
 *   production build must omit it rather than reference a database that
 *   does not exist (see vite.config.ts).
 */
export function d1DatabaseBindings({ binding, databaseId, databaseName } = {}) {
  if (!binding || !databaseId) return [];
  return [{
    binding,
    database_name: databaseName ?? "site-creator-d1",
    database_id: databaseId,
    migrations_dir: D1_MIGRATIONS_DIR,
  }];
}
