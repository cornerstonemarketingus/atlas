import { githubContentObservation, githubRequestObservation, logGitHubObservation } from "../tasks/github-observability.mjs";

// The route creates one context per authenticated request and shares it with
// child agents. A WeakMap never shares bytes between requests/principals and
// releases the scope when that chat turn is gone. No mutable branch alias is
// cached: only verified blobs and explicitly supplied full commit IDs.
const scopes = new WeakMap();
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
// GitHub forbids 40-hex branch/tag names. Do not assume that for 64-hex refs.
const COMMIT = /^[a-f0-9]{40}$/u;
const MAX_BODY_BYTES = 2_000_000;
const MAX_FILE_BYTES = 512_000;
const MAX_CACHE_BYTES = 2_000_000;
const MAX_ENTRIES = 16;

function observe(context, event) {
  try { (context.observeGitHub ?? logGitHubObservation)(event); } catch { /* telemetry cannot fail a read */ }
}

async function boundedBody(response, received) {
  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0; let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      received(bytes);
      if (bytes > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw Object.assign(new Error("Repository response exceeds the retrieval bound."), { code: "REPOSITORY_RESPONSE_TOO_LARGE" }); }
      text += decoder.decode(next.value, { stream: true });
    }
    return { text: text + decoder.decode(), bytes };
  } finally { reader.releaseLock(); }
}

async function verifiedFile(body) {
  if (body?.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string" || !SHA.test(body.sha ?? "")) return null;
  // Verification is an admission rule, not a change to legacy read behavior.
  // Unverifiable/oversized payloads can still be read, but are never reused.
  if (body.content.length > MAX_FILE_BYTES * 1.5) return null;
  let bytes;
  try { bytes = Uint8Array.from(atob(body.content.replace(/\s+/gu, "")), char => char.charCodeAt(0)); } catch { return null; }
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return null;
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(prefix.length + bytes.length);
  object.set(prefix); object.set(bytes, prefix.length);
  const digest = await crypto.subtle.digest(body.sha.length === 40 ? "SHA-1" : "SHA-256", object);
  const sha = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (sha !== body.sha) return null;
  return { body: Object.freeze({ type: "file", encoding: "base64", content: body.content, sha }), contentBytes: bytes.length, size: body.content.length * 2 + 256 };
}

function put(scope, key, value) {
  if (value.size > MAX_CACHE_BYTES) return;
  if (scope.entries.has(key)) scope.bytes -= scope.entries.get(key).size;
  scope.entries.delete(key);
  while (scope.entries.size >= MAX_ENTRIES || scope.bytes + value.size > MAX_CACHE_BYTES) {
    const oldest = scope.entries.keys().next().value;
    scope.bytes -= scope.entries.get(oldest).size;
    scope.entries.delete(oldest);
  }
  scope.entries.set(key, value); scope.bytes += value.size;
}

/** Called only AFTER repositoryAccess checks this context's allowlist and credential. */
export async function readRepositoryContent({ context, repository, path, ref, fileSha, token, fetcher, headers, timeoutMs }) {
  let scope = scopes.get(context);
  if (!scope || scope.token !== token) {
    scope = { token, entries: new Map(), pending: new Map(), bytes: 0 };
    scopes.set(context, scope);
  }
  const startedAt = Date.now();
  const key = version => JSON.stringify([repository, path, ref, version]);
  const version = fileSha ? `blob:${fileSha}` : COMMIT.test(ref) ? `commit:${ref}` : null;
  const cached = version ? scope.entries.get(key(version)) : null;
  if (cached) {
    scope.entries.delete(key(version)); scope.entries.set(key(version), cached);
    observe(context, githubContentObservation({ cache: "hit", contentBytes: cached.contentBytes, latencyMs: Date.now() - startedAt }));
    return { ok: true, status: 200, body: cached.body };
  }
  // Pending calls can share one current observation even for a moving ref.
  // Completed moving-ref observations are never reused without a blob pin.
  const pendingKey = key("retrieval");
  if (scope.pending.has(pendingKey)) {
    let result;
    try { return result = await scope.pending.get(pendingKey); }
    finally { observe(context, githubContentObservation({ cache: "coalesced", contentBytes: result?.contentBytes ?? 0, latencyMs: Date.now() - startedAt })); }
  }
  if (scope.cooldown?.until > Date.now()) {
    observe(context, githubContentObservation({ cache: "cooldown" }));
    return { ok: false, status: scope.cooldown.status, retryAfterMs: scope.cooldown.until - Date.now() };
  }
  if (scope.pending.size >= MAX_ENTRIES) throw new Error("Too many concurrent repository reads.");
  observe(context, githubContentObservation({ cache: "miss" }));
  const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${repository}/contents/${encodedPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const retrieve = async () => {
    let response; let outcome = "network_failure"; let responseBodyBytes = 0;
    try {
      response = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      outcome = "http_failure";
      if (!response.ok) {
        const { rateLimit } = githubRequestObservation({ url, response, outcome, startedAt, endedAt: Date.now() });
        let retryAfterMs;
        if ([403, 429].includes(response.status) && (response.status === 429 || rateLimit.remaining === 0 || rateLimit.retryAfterMs !== null)) {
          const reset = rateLimit.remaining === 0 && rateLimit.resetEpochSeconds !== null ? Math.max(0, rateLimit.resetEpochSeconds * 1000 - Date.now()) : null;
          retryAfterMs = rateLimit.retryAfterMs === null && reset === null ? 60_000 : Math.max(rateLimit.retryAfterMs ?? 0, reset ?? 0);
          scope.cooldown = { status: response.status, until: Date.now() + retryAfterMs };
        }
        await response.body?.cancel().catch(() => {});
        return { ok: false, status: response.status, retryAfterMs };
      }
      outcome = "network_failure";
      const raw = await boundedBody(response, bytes => { responseBodyBytes = bytes; });
      outcome = "invalid_response";
      const body = JSON.parse(raw.text);
      const verified = await verifiedFile(body);
      if (verified) {
        put(scope, key(`blob:${verified.body.sha}`), verified);
        if (COMMIT.test(ref)) put(scope, key(`commit:${ref}`), verified);
      }
      outcome = "success";
      return { ok: true, status: response.status, body, contentBytes: verified?.contentBytes ?? 0 };
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") outcome = "timeout";
      if (error?.code === "REPOSITORY_RESPONSE_TOO_LARGE") outcome = "response_too_large";
      throw error;
    } finally {
      observe(context, githubRequestObservation({ url, response, outcome, startedAt, endedAt: Date.now(), source: "hosted_chat", responseBodyBytes }));
    }
  };
  const pending = retrieve();
  scope.pending.set(pendingKey, pending);
  try { return await pending; } finally { scope.pending.delete(pendingKey); }
}
