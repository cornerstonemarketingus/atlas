import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const MERGE_POLICIES = ["manual", "ci-gated", "none"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

export const PLAN_TIERS = ["free", "pro", "team"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const SUBSCRIPTION_STATUSES = ["active", "past_due", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Modes and monthly task caps per tier. Team differs from Pro only in cap and seat count today. */
export const TIER_LIMITS: Readonly<Record<PlanTier, { readonly modes: readonly string[]; readonly monthlyTasks: number }>> = {
  free: { modes: ["inspect", "debug"], monthlyTasks: 20 },
  pro: { modes: ["inspect", "debug", "coder"], monthlyTasks: 200 },
  team: { modes: ["inspect", "debug", "coder"], monthlyTasks: 1000 },
};

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubUserId: integer("github_user_id").notNull(),
  githubLogin: text("github_login").notNull(),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  githubUserIdIndex: uniqueIndex("users_github_user_id_idx").on(table.githubUserId),
}));

export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  tier: text("tier").notNull().default("free"),
  status: text("status").notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodEnd: text("current_period_end"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIndex: uniqueIndex("subscriptions_user_id_idx").on(table.userId),
  stripeCustomerIdIndex: uniqueIndex("subscriptions_stripe_customer_id_idx").on(table.stripeCustomerId),
}));

/** One row per user per calendar month (periodStart = "YYYY-MM-01"), incremented on each dispatched task. */
export const taskUsage = sqliteTable("task_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  periodStart: text("period_start").notNull(),
  taskCount: integer("task_count").notNull().default(0),
}, (table) => ({
  userPeriodIndex: uniqueIndex("task_usage_user_period_idx").on(table.userId, table.periodStart),
}));

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
