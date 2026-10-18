import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const privateError = 'PRIVATE_DATABASE /srv/internal/account.ts token=private';
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
let source = await readFile(new URL('../app/api/account/route.ts', import.meta.url), 'utf8');
const replacements = {
  'drizzle-orm': 'export const eq=(...args)=>args;export const and=(...args)=>args;',
  '../../../db': 'export const getDb=()=>globalThis.__overviewFixture.db;',
  '../../../db/schema': "export const users={id:'id'};export const taskUsage={userId:'userId',periodStart:'periodStart'};",
  '../billing/plan.mjs': 'export const currentPlan=async(db,id)=>{const f=globalThis.__overviewFixture;f.planUser=id;if(f.failure===\'plan\')throw new Error(f.privateError);return f.plan;};',
  '../billing/period.mjs': "export const currentPeriodStart=()=> '2026-10-01';",
  '../tasks/operator-auth.mjs': 'export const authenticatedAccount=async()=>{const f=globalThis.__overviewFixture;if(f.failure===\'auth\')throw new Error(f.privateError);return f.account;};',
  '../customer-failure.mjs': null,
};
for (const [name, code] of Object.entries(replacements)) {
  source = source.replaceAll(`from "${name}"`, `from ${JSON.stringify(code === null ? new URL('../app/api/customer-failure.mjs', import.meta.url).href : moduleUrl(code))}`);
}
const { GET } = await import(moduleUrl(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));
const request = () => new Request('https://atlas.example/api/account');
function fixture(failure) {
  const f = { failure, privateError, account: { userId: 'customer', dbUserId: 7 }, conditions: [],
    plan: { tier: 'free', status: 'active', limits: { monthlyTasks: 20, modes: ['chat'] } } };
  let selects = 0;
  f.db = { select() {
    selects++;
    if (failure === 'database' || (failure === 'usage' && selects === 2)) throw new Error(privateError);
    return { from() { return this; }, where(condition) {
      f.conditions.push(condition);
      return Promise.resolve(selects === 1 ? [{ githubLogin: 'customer', avatarUrl: null, privateNote: privateError }] : [{ taskCount: 3 }]);
    } };
  } };
  globalThis.__overviewFixture = f;
  return f;
}

test('account overview catches auth, database, plan and usage failures without public diagnostics', async () => {
  for (const failure of ['auth', 'database', 'plan', 'usage']) {
    fixture(failure);
    const response = await GET(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.code, 'ACCOUNT_REQUEST_UNAVAILABLE');
    assert.match(body.reference, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(body).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(body).includes('/srv/'), false);
  }
});

test('account overview preserves signed-out, owner and scoped customer responses', async () => {
  let f = fixture(); f.account = null;
  assert.deepEqual(await (await GET(request())).json(), { signedIn: false });
  f = fixture(); f.account.dbUserId = null;
  assert.deepEqual(await (await GET(request())).json(), { signedIn: true, userId: 'customer', unrestricted: true });
  f = fixture();
  assert.deepEqual(await (await GET(request())).json(), { signedIn: true, userId: 'customer', githubLogin: 'customer', avatarUrl: null, tier: 'free', status: 'active', usage: { used: 3, limit: 20 }, modes: ['chat'] });
  assert.equal(f.planUser, 7);
  assert.deepEqual(f.conditions, [['id', 7], [['userId', 7], ['periodStart', '2026-10-01']]]);
});
