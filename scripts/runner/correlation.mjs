/**
 * Correlation id handling for the runner scripts. The id arrives as the
 * optional `correlation_id` workflow_dispatch input (via ATLAS_CORRELATION_ID
 * in env, never interpolated into shell) and ties this run's logs, PR body and
 * result callback back to the dispatch that started it.
 *
 * Format mirrors packages/atlas-contracts: `cor_` + 32 lowercase hex. Anything
 * else is dropped (never echoed), so a hand-dispatched run cannot smuggle text
 * into logs or the PR body through this input.
 */
export const CORRELATION_ID_PATTERN = /^cor_[0-9a-f]{32}$/;

export function isCorrelationId(value) {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

/** Returns the validated id, or null when absent or malformed. */
export function correlationIdFromEnv(env = process.env) {
  const value = env.ATLAS_CORRELATION_ID ?? env.CORRELATION_ID;
  return isCorrelationId(value) ? value : null;
}

/** A log line fragment, empty when there is no valid id. */
export function correlationLogSuffix(correlationId) {
  return isCorrelationId(correlationId) ? ` [correlation ${correlationId}]` : "";
}

/** PR body footer lines; empty when there is no valid id. */
export function correlationFooter(correlationId) {
  return isCorrelationId(correlationId) ? ["", `Atlas-Correlation-Id: ${correlationId}`] : [];
}

/** Adds `correlationId` to a result payload only when it is valid. */
export function withCorrelationId(payload, correlationId) {
  return isCorrelationId(correlationId) ? { ...payload, correlationId } : payload;
}
