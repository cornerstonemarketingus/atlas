import { TASK_REQUEST_KEY, taskRequestFingerprint } from "../api/tasks/task-request-contract.mjs";

export const PENDING_REQUEST_STORAGE = "atlas.pending-task-requests.v1";

function readKeys(storage) {
  const raw = storage.getItem(PENDING_REQUEST_STORAGE);
  const keys = raw ? JSON.parse(raw) : {};
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.entries(keys).some(([hash, key]) => !/^[0-9a-f]{64}$/u.test(hash) || !TASK_REQUEST_KEY.test(key))) throw new Error("Saved requests unavailable");
  return keys;
}

/** Persist only a digest and opaque key; never store objectives or credentials. */
export async function submitTaskRequest(payload, { storage, fetcher = fetch }) {
  const fingerprint = await taskRequestFingerprint(payload);
  const keys = readKeys(storage);
  let key = keys[fingerprint];
  if (!key) {
    if (Object.keys(keys).length >= 256) throw new Error("Too many unresolved requests");
    key = globalThis.crypto.randomUUID();
    storage.setItem(PENDING_REQUEST_STORAGE, JSON.stringify({ ...keys, [fingerprint]: key }));
  }
  const response = await fetcher("/api/tasks/requests", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(payload) });
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request response unavailable");
  if (body.requestState === "completed") {
    const latest = readKeys(storage);
    if (latest[fingerprint] === key) { delete latest[fingerprint]; storage.setItem(PENDING_REQUEST_STORAGE, JSON.stringify(latest)); }
  }
  return { response, body };
}
