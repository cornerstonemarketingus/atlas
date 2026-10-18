import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleUrl = code => 'data:text/javascript,' + encodeURIComponent(code);
let source = await readFile(new URL('../app/api/setup/status/route.ts', import.meta.url), 'utf8');
const probe = `const probe=()=>{const f=globalThis.__setupFixture;f.probes++;if(f.disallowProbes)throw new Error('PRIVATE_BACKEND');return f};`;
const modules = {
  'drizzle-orm': 'export const sql=()=>({});',
  '../../../../db': probe + 'export const getDb=()=>{probe();return{run:async()=>{probe()}}};export const getD1=()=>{probe();return{}};',
  '../../tasks/storage-readiness.mjs': probe + "export const taskStorageReadiness=async()=>{probe();return{ready:false,message:'PRIVATE migration details'}};",
  '../../auth/github-oauth.mjs': probe + 'export const githubOAuthConfiguration=()=>{probe();return{configured:true}};',
  '../../billing/stripe.mjs': probe + 'export const stripeConfiguration=()=>{probe();return{configured:true}};',
  '../../chat/model-endpoint.mjs': probe + "export const chatReadiness=()=>{probe();return{configured:false,reason:'PRIVATE_MODEL'}};export const resolveChatModel=()=>{probe();return'PRIVATE_MODEL'};",
  '../../chat/providers.mjs': probe + "export const chatRoute=()=>{probe();return{provider:'PRIVATE_PROVIDER'}};",
  '../../inference/governor-client.mjs': probe + "export const governorReadiness=async()=>{probe();return{detail:'PRIVATE_GOVERNOR'}};",
  '../../inference/worker-env.mjs': 'export const workerEnv={};',
  '../../tasks/github-app.mjs': probe + 'export const githubAppConfiguration=()=>{probe();return{configured:false}};export const createInstallationToken=async()=>{probe();return null};',
  '../../tasks/dispatch.mjs': probe + "export const allowedRepositories=()=>{probe();return new Set(['private/repo'])};",
  '../../tasks/github-diagnosis.mjs': probe + "export const explainGitHubAppFailure=()=>({message:'PRIVATE_DISPATCH'});export const probeGitHubDispatch=async()=>{probe();return{ok:false,message:'PRIVATE_DISPATCH'}};",
  '../../tasks/github-token.mjs': probe + 'export const platformGitHubToken=()=>{probe();return null};',
  '../../tasks/operator-auth.mjs': `export const authenticatedAccount=async()=>{const f=globalThis.__setupFixture;if(f.authError)throw new Error('PRIVATE_AUTH');return f.account};`,
  '../../tasks/self-protection.mjs': new URL('../app/api/tasks/self-protection.mjs', import.meta.url).href,
  '../../customer-failure.mjs': new URL('../app/api/customer-failure.mjs', import.meta.url).href,
};
for (const [name, code] of Object.entries(modules)) source = source.replaceAll(`from "${name}"`, `from ${JSON.stringify(code.startsWith('file:') ? code : moduleUrl(code))}`);
const { GET } = await import(moduleUrl(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));
const request = () => new Request('https://atlas.example/api/setup/status');
const fixture = account => globalThis.__setupFixture = { account, probes: 0, disallowProbes: true };

test('customer setup response omits deployment diagnostics and performs no infrastructure probes', async () => {
  for (const userId of ['github:customer', 'github:operator', 'platform-customer']) {
    const f = fixture({ userId, dbUserId: userId === 'platform-customer' ? null : 7 });
    const response = await GET(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { version: 1, audience: 'customer', overall: 'account-ready', completedSteps: 1, totalSteps: 1, steps: [{ id: 'account', label: 'Account connected', state: 'complete', detail: 'Manage your projects and permissions on this page.' }], optional: {} });
    assert.equal(f.probes, 0);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE|D1|migration|credential|provider|governor/);
  }
});

test('existing deployment owner retains infrastructure diagnostics', async () => {
  const f = fixture({ userId: 'operator', dbUserId: null }); f.disallowProbes = false;
  const response = await GET(request()); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.audience, 'owner');
  assert.equal(body.steps.length, 8); assert.ok(f.probes > 0);
  assert.ok(body.steps.some(item => item.detail.includes('PRIVATE migration')));
  assert.equal(body.optional.inferenceGovernor.detail, 'PRIVATE_GOVERNOR');
});

test('setup authentication denial and faults remain customer-safe without probing services', async () => {
  let f = fixture(null); assert.equal((await GET(request())).status, 401); assert.equal(f.probes, 0);
  f = fixture(null); f.authError = true;
  const response = await GET(request()); assert.equal(response.status, 503);
  const body = await response.json(); assert.match(body.reference, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE/); assert.equal(f.probes, 0);
});
