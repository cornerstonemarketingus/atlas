/** Kept schema-import-free so it can be unit-tested under plain `node --test` (no bundler). */
export function currentPeriodStart(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Key of a user's daily chat counter. It lives in task_usage beside the monthly
 * task counter (same atomic upsert, same account-deletion cleanup, no migration);
 * the "chat:" prefix cannot collide with a monthly "YYYY-MM-01" key.
 */
export function currentChatDayKey(now) {
  return `chat:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

/** When the daily chat counter resets (next 00:00 UTC), as an ISO string. */
export function nextChatReset(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}
