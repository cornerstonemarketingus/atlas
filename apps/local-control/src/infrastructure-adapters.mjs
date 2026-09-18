import { createHash, randomUUID } from "node:crypto";

const ACTIONS = new Set(["cloudflare.dns.upsert", "vercel.environment.upsert", "vercel.deployment.create"]);
const SECRET_REFERENCE = /^(?:env|vault):[A-Z][A-Z0-9_]{2,127}$/u;

export function createInfrastructureAdmin({ fetchImpl = fetch, resolveSecret }) {
  if (typeof resolveSecret !== "function") throw new Error("A local secret resolver is required.");

  return {
    preview(action, input) {
      const normalized = validateAndNormalize(action, input);
      const digest = actionDigest(action, normalized);
      return { id: randomUUID(), action, digest, capability: capabilityFor(action), preview: redact(action, normalized), input: normalized, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    },
    async execute(plan) {
      if (!plan || !ACTIONS.has(plan.action) || plan.digest !== actionDigest(plan.action, plan.input)) throw new Error("The approved infrastructure action no longer matches its digest.");
      if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error("The infrastructure action preview has expired.");
      const result = plan.action === "cloudflare.dns.upsert"
        ? await upsertCloudflareDns(plan.input, { fetchImpl, resolveSecret })
        : plan.action === "vercel.environment.upsert"
          ? await upsertVercelEnvironment(plan.input, { fetchImpl, resolveSecret })
          : await createVercelDeployment(plan.input, { fetchImpl, resolveSecret });
      return { ...result, action: plan.action, digest: plan.digest, preview: plan.preview };
    },
  };
}

export function environmentSecretResolver(reference) {
  if (!SECRET_REFERENCE.test(reference) || !reference.startsWith("env:")) throw new Error("Only validated env: secret references are available in this runtime.");
  const value = process.env[reference.slice(4)];
  if (!value) throw new Error(`Credential reference ${reference} is not configured.`);
  return value;
}

export function actionDigest(action, input) {
  return createHash("sha256").update(canonical({ action, input })).digest("hex");
}

function validateAndNormalize(action, input) {
  if (!ACTIONS.has(action)) throw new Error("Unsupported infrastructure action.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Infrastructure action input must be an object.");
  const credentialRef = secretRef(input.credentialRef, "credentialRef");
  if (action === "cloudflare.dns.upsert") return {
    credentialRef, zoneId: identifier(input.zoneId, "zoneId"), recordId: optionalIdentifier(input.recordId, "recordId"),
    type: oneOf(String(input.type ?? "").toUpperCase(), ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"], "type"),
    name: hostname(input.name), content: bounded(input.content, "content", 4096), ttl: integer(input.ttl ?? 1, 1, 86400, "ttl"),
    proxied: typeof input.proxied === "boolean" ? input.proxied : false,
  };
  if (action === "vercel.environment.upsert") return {
    credentialRef, projectId: identifier(input.projectId, "projectId"), teamId: optionalIdentifier(input.teamId, "teamId"),
    key: envKey(input.key), valueRef: secretRef(input.valueRef, "valueRef"),
    targets: uniqueArray(input.targets, ["production", "preview", "development"], "targets"),
    type: oneOf(input.type ?? "encrypted", ["encrypted", "sensitive"], "type"),
  };
  const gitSource = input.gitSource;
  if (!gitSource || typeof gitSource !== "object") throw new Error("gitSource is required.");
  return {
    credentialRef, projectId: identifier(input.projectId, "projectId"), teamId: optionalIdentifier(input.teamId, "teamId"),
    name: identifier(input.name, "name"), target: oneOf(input.target ?? "production", ["production", "preview"], "target"),
    gitSource: { type: oneOf(gitSource.type, ["github", "gitlab", "bitbucket"], "gitSource.type"), ref: bounded(gitSource.ref, "gitSource.ref", 200), repoId: bounded(String(gitSource.repoId ?? ""), "gitSource.repoId", 200) },
  };
}

async function upsertCloudflareDns(input, { fetchImpl, resolveSecret }) {
  const token = await resolveSecret(input.credentialRef);
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(input.zoneId)}/dns_records`;
  let recordId = input.recordId;
  if (!recordId) {
    const query = new URL(base); query.searchParams.set("type", input.type); query.searchParams.set("name", input.name);
    const found = await jsonRequest(fetchImpl, query, { headers: bearer(token) });
    if (found.result?.length > 1) throw new Error("Multiple matching DNS records exist; supply recordId explicitly.");
    recordId = found.result?.[0]?.id;
  }
  const body = { type: input.type, name: input.name, content: input.content, ttl: input.ttl, proxied: input.proxied };
  const changed = await jsonRequest(fetchImpl, recordId ? `${base}/${encodeURIComponent(recordId)}` : base, { method: recordId ? "PUT" : "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });
  const id = changed.result?.id;
  if (!id) throw new Error("Cloudflare did not return a DNS record identifier.");
  const verified = await jsonRequest(fetchImpl, `${base}/${encodeURIComponent(id)}`, { headers: bearer(token) });
  if (verified.result?.name !== input.name || verified.result?.type !== input.type || verified.result?.content !== input.content) throw new Error("Cloudflare DNS post-change verification failed.");
  return { ok: true, resourceId: id, operation: recordId ? "updated" : "created", verified: true };
}

async function upsertVercelEnvironment(input, { fetchImpl, resolveSecret }) {
  const [token, value] = await Promise.all([resolveSecret(input.credentialRef), resolveSecret(input.valueRef)]);
  const url = vercelUrl(`/v10/projects/${encodeURIComponent(input.projectId)}/env`, input.teamId);
  const changed = await jsonRequest(fetchImpl, url, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ key: input.key, value, target: input.targets, type: input.type, upsert: true }) });
  const id = changed.created?.id ?? changed.id;
  if (!id) throw new Error("Vercel did not return an environment-variable identifier.");
  const verified = await jsonRequest(fetchImpl, vercelUrl(`/v9/projects/${encodeURIComponent(input.projectId)}/env/${encodeURIComponent(id)}`, input.teamId), { headers: bearer(token) });
  if (verified.key !== input.key) throw new Error("Vercel environment-variable post-change verification failed.");
  return { ok: true, resourceId: id, operation: "upserted", verified: true };
}

async function createVercelDeployment(input, { fetchImpl, resolveSecret }) {
  const token = await resolveSecret(input.credentialRef);
  const changed = await jsonRequest(fetchImpl, vercelUrl("/v13/deployments", input.teamId), { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ name: input.name, project: input.projectId, target: input.target, gitSource: input.gitSource }) });
  if (!changed.id) throw new Error("Vercel did not return a deployment identifier.");
  const verified = await jsonRequest(fetchImpl, vercelUrl(`/v13/deployments/${encodeURIComponent(changed.id)}`, input.teamId), { headers: bearer(token) });
  return { ok: true, resourceId: changed.id, operation: "created", verified: verified.id === changed.id, state: verified.readyState ?? verified.status ?? "QUEUED" };
}

async function jsonRequest(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options); const text = await response.text(); let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Provider returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok || data.success === false || data.error) {
    const code = data.errors?.[0]?.code ?? data.error?.code ?? data.code;
    throw new Error(`Provider rejected the request (HTTP ${response.status}${code == null ? "" : `, code ${String(code).replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 40)}`}). Response text is withheld to protect secrets.`);
  }
  return data;
}

function redact(action, input) {
  const base = { provider: action.split(".")[0], action, credentialRef: input.credentialRef };
  if (action === "cloudflare.dns.upsert") return { ...base, zoneId: input.zoneId, recordId: input.recordId, record: { type: input.type, name: input.name, content: redactValue(input.content), ttl: input.ttl, proxied: input.proxied } };
  if (action === "vercel.environment.upsert") return { ...base, projectId: input.projectId, teamId: input.teamId, key: input.key, valueRef: input.valueRef, value: "[secret resolved locally at execution]", targets: input.targets, type: input.type };
  return { ...base, projectId: input.projectId, teamId: input.teamId, name: input.name, target: input.target, gitSource: input.gitSource };
}

function capabilityFor(action) { return action.startsWith("cloudflare.dns.") ? "infrastructure.dns.write" : action === "vercel.environment.upsert" ? "infrastructure.secrets.write" : "infrastructure.deploy.production"; }
function bearer(value) { return { authorization: `Bearer ${value}` }; }
function vercelUrl(path, teamId) { const url = new URL(path, "https://api.vercel.com"); if (teamId) url.searchParams.set("teamId", teamId); return url; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function redactValue(value) { if (value.length <= 6) return "[redacted]"; return `${value.slice(0, 2)}…${value.slice(-2)}`; }
function bounded(value, name, max) { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} is required and must be at most ${max} characters.`); return value.trim(); }
function identifier(value, name) { const result = bounded(value, name, 200); if (!/^[A-Za-z0-9_.-]+$/u.test(result)) throw new Error(`${name} is invalid.`); return result; }
function optionalIdentifier(value, name) { return value == null || value === "" ? null : identifier(value, name); }
function hostname(value) { const result = bounded(value, "name", 253).toLowerCase(); if (!/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(result)) throw new Error("name is not a valid DNS hostname."); return result; }
function secretRef(value, name) { if (typeof value !== "string" || !SECRET_REFERENCE.test(value)) throw new Error(`${name} must be an env: or vault: credential reference.`); return value; }
function envKey(value) { const result = bounded(value, "key", 128); if (!/^[A-Z_][A-Z0-9_]*$/u.test(result)) throw new Error("key is not a valid environment-variable name."); return result; }
function integer(value, min, max, name) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} through ${max}.`); return value; }
function oneOf(value, allowed, name) { if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}.`); return value; }
function uniqueArray(value, allowed, name) { if (!Array.isArray(value) || value.length < 1 || value.some((item) => !allowed.includes(item))) throw new Error(`${name} must contain supported values.`); return [...new Set(value)]; }
