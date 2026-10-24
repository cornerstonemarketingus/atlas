import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { signSession } from '../app/api/auth/session.mjs';

// The real route with the real authentication, owner check and provider
// diagnostics. Only the Worker binding module (which needs the Workers
// runtime) is replaced, and Cloudflare's API is answered by a fake fetch.
const moduleUrl = code => 'data:text/javascript,' + encodeURIComponent(code);
const real = path => new URL(path, import.meta.url).href;
let source = await readFile(new URL('../app/api/setup/providers/route.ts', import.meta.url), 'utf8');
const modules = {
  '../../chat/provider-health.mjs': real('../app/api/chat/provider-health.mjs'),
  '../../chat/providers.mjs': real('../app/api/chat/providers.mjs'),
  '../../chat/workers-ai-binding.mjs': real('../app/api/chat/workers-ai-binding.mjs'),
  '../../inference/worker-env.mjs': moduleUrl('export const workerEnv=globalThis.__providersWorkerEnv;'),
  '../../tasks/operator-auth.mjs': real('../app/api/tasks/operator-auth.mjs'),
  '../../tasks/self-protection.mjs': real('../app/api/tasks/self-protection.mjs'),
  '../../customer-failure.mjs': real('../app/api/customer-failure.mjs'),
};
for (const [name, target] of Object.entries(modules)) {
  assert.ok(source.includes(`from "${name}"`), `route still imports ${name}`);
  source = source.replaceAll(`from "${name}"`, `from ${JSON.stringify(target)}`);
}
let bindingCalls = 0;
globalThis.__providersWorkerEnv = { AI: { run: async () => { bindingCalls++; return { response: 'OK' }; } } };
const { GET } = await import(moduleUrl(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));

const OPERATOR_TOKEN = 'operator-token-SECRET-1f4c';
const SESSION_SECRET = 'session-secret-SECRET-9a7d-long-enough-for-hmac';
const WORKERS_AI_TOKEN = 'cf-workers-ai-token-SECRET-77e1';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const SECRETS = [OPERATOR_TOKEN, SESSION_SECRET, WORKERS_AI_TOKEN, ACCOUNT_ID];

function environment(t) {
  const saved = { ...process.env };
  Object.assign(process.env, { ATLAS_OPERATOR_TOKEN: OPERATOR_TOKEN, ATLAS_SESSION_SECRET: SESSION_SECRET, ATLAS_WORKERS_AI_TOKEN: WORKERS_AI_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID });
  delete process.env.ATLAS_TRUST_PLATFORM_HEADERS;
  const fetchBefore = globalThis.fetch;
  const calls = [];
  // Cloudflare answers like a healthy Workers AI token, and echoes the
  // token back in a message field, as provider error text sometimes does.
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    const body = String(url).includes('/tokens/verify') ? { success: true, result: { status: 'active', id: WORKERS_AI_TOKEN }, messages: [{ message: `token ${WORKERS_AI_TOKEN}` }] }
      : String(url).includes('/ai/models/search') ? { success: true, result: [{ name: 'model' }] }
      : { choices: [{ message: { content: 'OK' } }], note: init.headers?.authorization };
    return Response.json(body);
  };
  bindingCalls = 0;
  t.after(() => { globalThis.fetch = fetchBefore; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  return calls;
}
const request = headers => new Request('https://atlas.example/api/setup/providers', { headers });
const sessionCookie = async payload => ({ cookie: `atlas_session=${await signSession(payload, SESSION_SECRET)}` });

test('the deployment owner signed in with GitHub can run provider diagnostics', async t => {
  const calls = environment(t);
  // The GitHub callback signs an owner login as an operator-role session.
  const response = await GET(request(await sessionCookie({ role: 'operator', gh: 'owner-login' })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.providers.workersAI.category, 'OK');
  assert.equal(body.providers.workersAIBinding.binding, 'present');
  assert.ok(calls.length >= 3, 'the real diagnostics ran');
});

test('the operator token used by hosted smoke checks still works', async t => {
  environment(t);
  const response = await GET(request({ authorization: `Bearer ${OPERATOR_TOKEN}` }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, 1);
});

test('a signed-in customer who is not the owner is refused before any provider is called', async t => {
  const calls = environment(t);
  for (const headers of [
    await sessionCookie({ uid: 7, gh: 'customer' }),
    await sessionCookie({ uid: 8, gh: 'operator' }),
    { authorization: 'Bearer wrong-token' , ...(await sessionCookie({ uid: 9, gh: 'someone' })) },
  ]) {
    const response = await GET(request(headers));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { message: 'Only the owner can run provider diagnostics.' });
  }
  assert.equal(calls.length, 0); assert.equal(bindingCalls, 0);
});

test('a forged platform header is not an owner, and no session is a 401', async t => {
  const calls = environment(t);
  process.env.ATLAS_TRUST_PLATFORM_HEADERS = 'true';
  assert.equal((await GET(request({ 'oai-authenticated-user-id': 'operator' }))).status, 401);
  assert.equal((await GET(request({ 'oai-authenticated-user-id': 'platform-user' }))).status, 403);
  assert.equal((await GET(request({}))).status, 401);
  assert.equal(calls.length, 0);
});

test('provider diagnostics never return a secret, account id or provider message', async t => {
  environment(t);
  const response = await GET(request({ authorization: `Bearer ${OPERATOR_TOKEN}` }));
  const text = await response.text();
  for (const secret of SECRETS) assert.ok(!text.includes(secret), 'a secret value reached the response');
  assert.doesNotMatch(text, /Bearer|token cf-|"messages"/u);
});
