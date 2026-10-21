import { hostedSiteStore } from "../../db/hosted-sites.mjs";
import { migratedDatabase } from "./d1-sqlite.mjs";

/** A migrated in-memory D1 with the hosted-site store, for route and builder tests. */
export function hostedHarness() {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "owner"]] });
  return { sqlite, d1, store: hostedSiteStore(d1) };
}
