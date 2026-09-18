import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const MERGE_POLICIES = ["manual", "ci-gated", "none"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

export const PLAN_TIERS = ["free", "pro", "team"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const SUBSCRIPTION_STATUSES = ["active", "past_due", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Modes and monthly task caps per tier. Team differs from Pro only in cap and seat count today. */
export const TIER_LIMITS: Readonly<Record<PlanTier, {
  readonly modes: readonly string[];
  readonly monthlyTasks: number;
  /** Metered separately from tasks: a browser minute is a container, not a request. */
  readonly hostedBrowserMinutes: number;
}>> = {
  free: { modes: ["inspect", "debug"], monthlyTasks: 20, hostedBrowserMinutes: 0 },
  pro: { modes: ["inspect", "debug", "coder"], monthlyTasks: 200, hostedBrowserMinutes: 300 },
  team: { modes: ["inspect", "debug", "coder"], monthlyTasks: 1000, hostedBrowserMinutes: 2000 },
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
  /**
   * Epoch seconds of the newest Stripe event applied to this row. Stripe does
   * not guarantee delivery order, and an older `subscription.updated` arriving
   * after a newer one would downgrade a customer who just upgraded.
   */
  lastEventAt: integer("last_event_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIndex: uniqueIndex("subscriptions_user_id_idx").on(table.userId),
  stripeCustomerIdIndex: uniqueIndex("subscriptions_stripe_customer_id_idx").on(table.stripeCustomerId),
}));

/**
 * Every Stripe event id we have already applied. Stripe retries on timeouts,
 * on 500s, and on a deploy that lands mid-request, so duplicate delivery is
 * routine rather than exceptional.
 */
export const billingEvents = sqliteTable("billing_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  createdAt: integer("created_at").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** One row per user per calendar month; hosted browser minutes only. */
export const hostedBrowserUsage = sqliteTable("hosted_browser_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  periodStart: text("period_start").notNull(),
  minutesUsed: integer("minutes_used").notNull().default(0),
  activeSessions: integer("active_sessions").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userPeriodIndex: uniqueIndex("hosted_browser_usage_user_period_idx").on(table.userId, table.periodStart),
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

/**
 * One row per task dispatched to GitHub Actions, written at dispatch time so
 * the user can see what they started instead of having to dig through the
 * Actions UI.
 *
 * Two identity columns, deliberately:
 *   - `userId` is the D1 `users.id`, and is null for the operator-token and
 *     platform-header auth paths, which have no user row at all.
 *   - `requestedBy` is the stable principal string from `authenticatedAccount()`
 *     ("github:<login>", "operator", or the platform user id). It is what task
 *     listing filters on, because filtering on a nullable `userId` would put
 *     every operator-token and every distinct ChatGPT-platform user into one
 *     shared "null" bucket — and those are different customers, whose
 *     objectives describe their source-code intent.
 *
 * `githubRunId` is nullable because `POST /actions/workflows/{id}/dispatches`
 * returns 204 with no body: the run id does not exist yet at dispatch time and
 * is resolved later, heuristically (see app/api/tasks/run-status.mjs).
 */
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id").notNull(),
  userId: integer("user_id").references(() => users.id),
  requestedBy: text("requested_by").notNull(),
  repository: text("repository").notNull(),
  branch: text("branch").notNull(),
  mode: text("mode").notNull(),
  objective: text("objective").notNull(),
  mergePolicy: text("merge_policy").notNull().default("manual"),
  githubRunId: integer("github_run_id"),
  conversationId: text("conversation_id"),
  executionProvider: text("execution_provider").notNull().default("managed"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  taskIdIndex: uniqueIndex("tasks_task_id_idx").on(table.taskId),
  requestedByIndex: index("tasks_requested_by_created_at_idx").on(table.requestedBy, table.createdAt),
  conversationIndex: index("tasks_conversation_idx").on(table.conversationId, table.createdAt),
}));

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  requestedBy: text("requested_by").notNull(),
  title: text("title").notNull(),
  repository: text("repository").notNull(),
  branch: text("branch").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  archivedAt: text("archived_at"),
}, (table) => ({ ownerIndex: index("conversations_owner_updated_idx").on(table.requestedBy, table.updatedAt) }));

export const conversationMessages = sqliteTable("conversation_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  requestedBy: text("requested_by").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  attachmentsJson: text("attachments_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({ conversationIndex: index("conversation_messages_conversation_idx").on(table.conversationId, table.createdAt) }));

/** Safe user-facing milestones, not private model chain-of-thought. */
export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  taskId: text("task_id"),
  requestedBy: text("requested_by").notNull(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  detail: text("detail"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({ conversationIndex: index("run_events_conversation_idx").on(table.conversationId, table.createdAt) }));

/** A paired executor. Secrets are returned once and only their SHA-256 digest is stored. */
export const computerDevices = sqliteTable("computer_devices", {
  id: text("id").primaryKey(),
  requestedBy: text("requested_by").notNull(),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("windows"),
  secretHash: text("secret_hash").notNull(),
  status: text("status").notNull().default("offline"),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  ownerIndex: index("computer_devices_owner_created_at_idx").on(table.requestedBy, table.createdAt),
  secretHashIndex: uniqueIndex("computer_devices_secret_hash_idx").on(table.secretHash),
}));

/** Browser goals queued from the phone and leased by exactly one paired executor. */
export const computerTasks = sqliteTable("computer_tasks", {
  id: text("id").primaryKey(),
  requestedBy: text("requested_by").notNull(),
  deviceId: text("device_id").notNull().references(() => computerDevices.id),
  executionProvider: text("execution_provider").notNull().default("windows"),
  workflowType: text("workflow_type").notNull().default("custom"),
  approvalPolicy: text("approval_policy").notNull().default("consequential"),
  objective: text("objective").notNull(),
  startUrl: text("start_url"),
  status: text("status").notNull().default("queued"),
  result: text("result"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  heartbeatAt: text("heartbeat_at"),
  leaseExpiresAt: text("lease_expires_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
}, (table) => ({
  ownerIndex: index("computer_tasks_owner_created_at_idx").on(table.requestedBy, table.createdAt),
  deviceQueueIndex: index("computer_tasks_device_status_created_at_idx").on(table.deviceId, table.status, table.createdAt),
}));

/** Exact, one-time approval requested before a companion performs a consequential action. */
export const computerApprovals = sqliteTable("computer_approvals", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => computerTasks.id),
  requestedBy: text("requested_by").notNull(),
  actionHash: text("action_hash").notNull(),
  summary: text("summary").notNull(),
  domain: text("domain"),
  status: text("status").notNull().default("pending"),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  consumedAt: text("consumed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  taskIndex: index("computer_approvals_task_created_at_idx").on(table.taskId, table.createdAt),
  ownerStatusIndex: index("computer_approvals_owner_status_idx").on(table.requestedBy, table.status),
}));

export const accountDeletionRequests = sqliteTable("account_deletion_requests", {
  id: text("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  requestedBy: text("requested_by").notNull(),
  status: text("status").notNull().default("pending"),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  processedBy: text("processed_by"),
  processingNote: text("processing_note"),
}, (table) => ({
  ownerStatusIndex: index("account_deletion_owner_status_idx").on(table.requestedBy, table.status),
}));

/** Append-only, user-visible receipts for the operator control plane. */
export const computerTaskEvents = sqliteTable("computer_task_events", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => computerTasks.id),
  requestedBy: text("requested_by").notNull(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  detail: text("detail"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  taskIndex: index("computer_task_events_task_created_at_idx").on(table.taskId, table.createdAt),
  ownerIndex: index("computer_task_events_owner_created_at_idx").on(table.requestedBy, table.createdAt),
}));
