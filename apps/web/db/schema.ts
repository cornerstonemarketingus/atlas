import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const MERGE_POLICIES = ["manual", "ci-gated", "none"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

export const installations = sqliteTable("installations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubInstallationId: integer("github_installation_id").notNull(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  githubInstallationIdIndex: uniqueIndex("installations_github_installation_id_idx").on(table.githubInstallationId),
}));

export const repositories = sqliteTable("repositories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  installationId: integer("installation_id").references(() => installations.id),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  mergePolicy: text("merge_policy").notNull().default("manual"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  ownerNameIndex: uniqueIndex("repositories_owner_name_idx").on(table.owner, table.name),
}));
