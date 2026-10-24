import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createGovernorCore, handleGovernorRequest } from '../worker/inference-governor-core.mjs';
import { chatRouteSummary, providerChecks, quotaSummary } from '../app/setup/chat-health.mjs';

// The owner's setup status with the real chat readiness, chat route and
// governor readout, under an environment full of secrets. Database and
// GitHub probes are stubbed: they are not what this file is about.
const moduleUrl = code => 'data:text/javascript,' + encodeURIComponent(code);
const real = path => new URL(path, import.meta.url).href;
let source = await readFile(new URL('../app/api/setup/status/route.ts', import.meta.url), 'utf8');
const modules = {
  'drizzle-orm': moduleUrl('export const sql=()=>({});'),
  '../../../../db': moduleUrl('export const getDb=()=>({run:async()=>{}});export const getD1=()=>({});'),
  '../../tasks/storage-readiness.mjs': moduleUrl('export const taskStorageReadiness=async()=>({ready:true});'),
  '../../auth/github-oauth.mjs': moduleUrl('export const githubOAuthConfiguration=()=>({configured:true});'),
  '../../billing/stripe.mjs': moduleUrl('export const stripeConfiguration=()=>({configured:false});'),
  '../../chat/model-endpoint.mjs': real('../app/api/chat/model-endpoint.mjs'),
  '../../chat/providers.mjs': real('../app/api/chat/providers.mjs'),
  '../../inference/governor-client.mjs': real('../app/api/inference/governor-client.mjs'),
  '../../inference/worker-env.mjs': moduleUrl('export const workerEnv=globalThis.__healthWorkerEnv;'),
  '../../tasks/github-app.mjs': moduleUrl('export const githubAppConfiguration=()=>({configured:false});export const createInstallationToken=async()=>null;'),
  '../../tasks/dispatch.mjs': moduleUrl("export const allowedRepositories=()=>new Set(['owner/repo']);"),
  '../../tasks/github-diagnosis.mjs': moduleUrl("export const explainGitHubAppFailure=()=>({message:'x'});export const probeGitHubDispatch=async()=>({ok:true,message:'ok'});"),
  '../../tasks/github-token.mjs': moduleUrl("export const platformGitHubToken=()=>'gh-token';"),
  '../../tasks/operator-auth.mjs': moduleUrl("export const authenticatedAccount=async()=>({userId:'operator',dbUserId:null});"),
  '../../tasks/self-protection.mjs': real('../app/api/tasks/self-protection.mjs'),
  '../../customer-failure.mjs': real('../app/api/customer-failure.mjs'),
};
for (const [name, target] of Object.entries(modules)) source = source.replaceAll(`from "${name}"`, `from ${JSON.stringify(target)}`);

const fakeStorage = () => { const values = new Map(); return { async get(k) { return values.has(k) ? structuredClone(values.get(k)) : undefined; }, async put(k, v) { values.set(k, structuredClone(v)); }, async setAlarm() {} }; };
const core = createGovernorCore({ storage: fakeStorage(), now: () => 1_000 });
globalThis.__healthWorkerEnv = {
  AI: { run: async () => ({ response: 'OK' }) },
  INFERENCE_GOVERNOR: { idFromName: name => name, get: () => ({ fetch: request => handleGovernorRequest(core, request) }) },
};
const { GET } = await import(moduleUrl(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));

const SECRETS = {
  ATLAS_CHAT_BASE_URL: 'https://api.groq.com/openai/v1',
  ATLAS_CHAT_MODEL: 'private-model-name-SECRET',
  ATLAS_CHAT_FALLBACK_MODEL: 'private-fallback-SECRET',
  ATLAS_MODEL_API_KEY: 'gsk_SECRET_model_key_1234',
  GROQ_API_KEY: 'gsk_SECRET_groq_key_5678',
  OPENAI_API_KEY: 'sk-SECRET-openai-key-9999',
  ATLAS_WORKERS_AI_TOKEN: 'cf-SECRET-workers-ai-token',
  CLOUDFLARE_ACCOUNT_ID: 'abcdefabcdefabcdefabcdefabcdef12',
  ATLAS_TAVILY_API_KEY: 'tvly-SECRET-search-key',
  ATLAS_SESSION_SECRET: 'session-SECRET-value',
};

test('owner setup status reports the chat route and quota health without any secret or model name', async t => {
  const saved = { ...process.env };
  Object.assign(process.env, SECRETS);
  t.after(() => { for (const key of Object.keys(SECRETS)) delete process.env[key]; Object.assign(process.env, saved); });
  // Put the ledger into a limit and an account pause on the chat endpoint's scope.
  await core.reserve({ requestId: 'a', models: [SECRETS.ATLAS_CHAT_MODEL], estimatedTokens: 5 });
  await core.release({ requestId: 'a', status: 429, retryAfterMs: 60_000 });
  await core.reserve({ requestId: 'b', models: [SECRETS.ATLAS_CHAT_FALLBACK_MODEL], estimatedTokens: 5 });
  await core.release({ requestId: 'b', kind: 'BILLING' });

  const response = await GET(new Request('https://atlas.example/api/setup/status'));
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const [name, value] of Object.entries(SECRETS)) {
    if (name === 'ATLAS_CHAT_BASE_URL') continue; // the public provider origin is not a secret, and is not echoed either
    assert.ok(!text.includes(value), `${name} reached setup status`);
  }
  assert.doesNotMatch(text, /api\.groq\.com|gsk_|sk-|tvly-/u);
  const body = JSON.parse(text);
  assert.ok(body.optional.chat.route.length >= 2, 'the route lists provider kinds');
  assert.ok(body.optional.chat.route.every(kind => ['groq', 'openai', 'workers-ai', 'self-hosted'].includes(kind)));
  assert.equal(body.optional.inferenceGovernor.accountPause.kind, 'BILLING');

  // What the Connections page renders from it is plain language, and still secret-free.
  const rendered = JSON.stringify([chatRouteSummary(body.optional.chat), quotaSummary(body.optional.inferenceGovernor, new Date(1_000))]);
  assert.match(rendered, /Groq/u);
  assert.match(rendered, /out of credit or quota/u);
  for (const value of Object.values(SECRETS)) assert.ok(!rendered.includes(value));
});

test('Connections helpers never echo server text, even from a hostile or broken response', () => {
  const hostile = 'gsk_SECRET_leak https://evil.example <script>';
  const rendered = JSON.stringify([
    chatRouteSummary({ configured: true, reason: hostile, route: [hostile, 'groq'], modelPoolSize: hostile }),
    quotaSummary({ bound: true, reachable: true, accountPause: { kind: hostile, until: hostile }, models: hostile, detail: hostile }),
    quotaSummary({ detail: hostile }),
    providerChecks({ providers: { workersAI: { category: hostile, recommendedAction: hostile, http: { verify: 401 } }, workersAIBinding: { category: 'OK', model: hostile } } }),
    providerChecks(hostile),
  ]);
  assert.ok(!rendered.includes('SECRET'));
  assert.ok(!rendered.includes('evil.example'));
  assert.ok(!rendered.includes('<script>'));
});
