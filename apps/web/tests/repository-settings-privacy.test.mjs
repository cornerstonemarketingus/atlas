import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleUrl = code => 'data:text/javascript,' + encodeURIComponent(code);
const privateError = 'PRIVATE /srv/atlas/tenancy.ts token=private';
let source = await readFile(new URL('../app/api/settings/repositories/route.ts', import.meta.url), 'utf8');
const modules = {
  '../../../../db': 'export const getD1=()=>({});',
  '../../../../db/tenancy.mjs': `const f=()=>globalThis.__settingsFixture;const check=name=>{if(f().failure===name)throw new Error(f().error)};
    export const canManageTenant=role=>['owner','admin'].includes(role);
    export const listTenantRepositories=async(db,id)=>{check('list');f().tenantIds.push(id);return f().rows};
    export const isDefaultTenant=async(db,id)=>{check('default');f().tenantIds.push(id);return f().defaultTenant};
    export const upsertTenantRepository=async(db,id,value)=>{check('upsert');f().writes.push({id,value})};
    export const deleteTenantRepository=async(db,id,value)=>{check('delete');f().writes.push({id,value});return f().removed};`,
  '../../auth/tenant-context.mjs': `export const NO_TENANT_MESSAGE='Choose a workspace.';export const resolveTenantContext=async()=>{const f=globalThis.__settingsFixture;if(f.failure==='tenant')throw new Error(f.error);return f.context};`,
  '../../tasks/dispatch.mjs': "export const allowedRepositories=()=>new Set(['owner/repo']);",
  '../../tasks/operator-auth.mjs': `export const authenticatedAccount=async()=>{const f=globalThis.__settingsFixture;if(f.failure==='auth')throw new Error(f.error);return f.account};`,
  './validation.mjs': new URL('../app/api/settings/repositories/validation.mjs', import.meta.url).href,
  '../../customer-failure.mjs': new URL('../app/api/customer-failure.mjs', import.meta.url).href,
};
for (const [name, code] of Object.entries(modules)) source = source.replaceAll(`from "${name}"`, `from ${JSON.stringify(code.startsWith('file:') ? code : moduleUrl(code))}`);
const handlers = await import(moduleUrl(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));
const setting = { owner: 'owner', name: 'repo', mergePolicy: 'manual' };
function fixture(failure, error = privateError) {
  return globalThis.__settingsFixture = { failure, error, account: { userId: 'customer' }, context: { tenantId: 17, role: 'owner', principal: 'customer' }, rows: [setting], tenantIds: [], writes: [], defaultTenant: false, removed: true };
}
const request = (method, body = setting) => new Request('https://atlas.example/api/settings/repositories', { method, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

for (const [method, failures] of Object.entries({ GET: ['auth', 'tenant', 'list', 'default'], PUT: ['auth', 'tenant', 'default', 'upsert'], DELETE: ['auth', 'tenant', 'delete'] })) {
  test(`actual repository ${method} hides backend faults and migration details`, async () => {
    for (const failure of failures) {
      for (const error of [privateError, 'no such table: PRIVATE_TENANT_TABLE']) {
        const f = fixture(failure, error);
        const response = await handlers[method](request(method));
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        assert.match(body.reference, /^[0-9a-f-]{36}$/);
        assert.doesNotMatch(JSON.stringify(body), /PRIVATE|migration|0015|\/srv\//);
        assert.equal(f.writes.length, 0);
      }
    }
  });
}

test('repository settings preserve tenant, role, allowlist, validation and scoped writes', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    let f = fixture(); f.account = null;
    assert.equal((await handlers[method](request(method))).status, 401);
    f = fixture(); f.context = null;
    assert.equal((await handlers[method](request(method))).status, 403);
  }
  for (const method of ['PUT', 'DELETE']) {
    let f = fixture(); f.context.role = 'member';
    assert.equal((await handlers[method](request(method))).status, 403); assert.equal(f.writes.length, 0);
    for (const body of [null, [], 'invalid', { owner: '../x', name: 'repo' }]) {
      f = fixture(); assert.equal((await handlers[method](request(method, body))).status, 400); assert.equal(f.writes.length, 0);
    }
  }
  let f = fixture();
  assert.equal((await handlers.PUT(request('PUT', { ...setting, name: 'outside' }))).status, 403); assert.equal(f.writes.length, 0);
  assert.equal((await handlers.PUT(request('PUT', { ...setting, mergePolicy: 'none' }))).status, 403); assert.equal(f.writes.length, 0);
  f = fixture();
  assert.deepEqual(await (await handlers.PUT(request('PUT'))).json(), setting);
  assert.deepEqual(f.writes, [{ id: 17, value: setting }]);
  f = fixture();
  assert.deepEqual(await (await handlers.DELETE(request('DELETE'))).json(), { removed: true, owner: 'owner', name: 'repo' });
  assert.deepEqual(f.writes, [{ id: 17, value: { owner: 'owner', name: 'repo' } }]);
  f = fixture(); f.removed = false;
  assert.equal((await handlers.DELETE(request('DELETE'))).status, 404);
  f = fixture(); f.context.role = 'member';
  const response = await handlers.GET(request('GET'));
  assert.deepEqual(await response.json(), { repositories: [setting], deploymentAllowlist: ['owner/repo'], defaultTenant: false, canManage: false });
  assert.deepEqual(f.tenantIds, [17, 17]);
});
