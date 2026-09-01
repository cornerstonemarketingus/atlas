/** Kept schema-import-free so it can be unit-tested under plain `node --test` (no bundler). */
export function currentPeriodStart(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
