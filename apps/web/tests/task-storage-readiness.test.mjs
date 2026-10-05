import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { taskStorageReadiness } from '../app/api/tasks/storage-readiness.mjs';
import { migratedDatabase } from './helpers/d1-sqlite.mjs';

test('task history readiness checks columns, including a skipped correlation migration', async () => {
  const { sqlite, d1 } = migratedDatabase();
  try {
    assert.equal((await taskStorageReadiness(d1)).ready, true);
    sqlite.exec('DROP INDEX tasks_correlation_id_idx; ALTER TABLE tasks DROP COLUMN correlation_id;');
    const result = await taskStorageReadiness(d1);
    assert.equal(result.ready, false);
    assert.deepEqual(result.missing, ['tasks.correlation_id']);
    assert.throws(() => sqlite.prepare('INSERT INTO tasks (correlation_id) VALUES (?)'), /no column/);
    sqlite.exec(await readFile(new URL('../drizzle/0013_task_correlation_id.sql', import.meta.url), 'utf8'));
    assert.equal((await taskStorageReadiness(d1)).ready, true);
  } finally { sqlite.close(); }
});

test('storage failures disclose no database error content', async () => {
  const result = await taskStorageReadiness({ prepare() { throw new Error('sensitive diagnostic'); } });
  assert.equal(result.code, 'TASK_STORAGE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});

test('lifecycle read columns are required even when task inserts would succeed', async () => {
  const { sqlite, d1 } = migratedDatabase();
  try {
    sqlite.exec('ALTER TABLE tasks DROP COLUMN github_run_id; ALTER TABLE conversations DROP COLUMN archived_at;');
    assert.deepEqual((await taskStorageReadiness(d1)).missing, ['tasks.github_run_id', 'conversations.archived_at']);
    const missingId = { prepare: query => ({ all: async () => {
      const result = await d1.prepare(query).all();
      return { ...result, results: query === 'PRAGMA table_info(tasks)' ? result.results.filter(column => column.name !== 'id') : result.results };
    } }) };
    assert.ok((await taskStorageReadiness(missingId)).missing.includes('tasks.id'));
  } finally { sqlite.close(); }
});

test('real setup GET reports missing task columns and withholds database error text', async () => {
  const { sqlite, d1 } = migratedDatabase();
  try {
    sqlite.exec('DROP INDEX tasks_correlation_id_idx; ALTER TABLE tasks DROP COLUMN correlation_id;');
    const source = await readFile(new URL('../app/api/setup/status/route.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      transformers: { before: [() => root => ts.factory.updateSourceFile(root, root.statements.filter(node => !ts.isImportDeclaration(node)))] },
    }).outputText.replaceAll('export async function', 'async function').replace(/export \{\};?/g, '');
    let database = d1;
    const dependencies = {
      getD1: () => database, getDb: () => ({ run: async () => {} }), sql: () => {}, taskStorageReadiness,
      authenticatedAccount: async () => ({ userId: 'operator', dbUserId: null }),
      githubOAuthConfiguration: () => ({ configured: true }), stripeConfiguration: () => ({ configured: false }),
      githubAppConfiguration: () => ({ configured: false }), platformGitHubToken: () => 'fixture',
      allowedRepositories: () => new Set(['owner/repo']), probeGitHubDispatch: async () => ({ ok: true }), chatReadiness: () => ({ configured: true }), chatRoute: () => ['groq'],
      resolveChatModel: () => ({ configured: true }), governorReadiness: async () => ({ bound: false }), workerEnv: {},
    };
    const { GET } = new Function(...Object.keys(dependencies), compiled + '; return { GET };')(...Object.values(dependencies));
    const request = new Request('https://atlas.test/api/setup/status');
    let body = await (await GET(request)).json();
    let migration = body.steps.find(step => step.id === 'migrations');
    assert.equal(migration.state, 'failed');
    assert.match(migration.detail, /tasks.correlation_id/);
    database = { prepare() { throw new Error('sensitive diagnostic'); } };
    body = await (await GET(request)).json();
    migration = body.steps.find(step => step.id === 'migrations');
    assert.equal(migration.state, 'failed');
    assert.match(migration.detail, /temporarily unavailable/);
    assert.doesNotMatch(JSON.stringify(body), /sensitive diagnostic/);
  } finally { sqlite.close(); }
});

test('real task POST refuses missing history schema before credentials, usage or dispatch', async () => {
  const { sqlite, d1 } = migratedDatabase();
  try {
    sqlite.exec('DROP INDEX tasks_correlation_id_idx; ALTER TABLE tasks DROP COLUMN correlation_id;');
    // Execute the actual route body with only its environment/auth dependencies injected.
    const source = await readFile(new URL('../app/api/tasks/route.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      transformers: { before: [() => root => ts.factory.updateSourceFile(root, root.statements.filter(node => !ts.isImportDeclaration(node)))] },
    }).outputText.replaceAll('export async function', 'async function').replace(/export \{\};?/g, '');
    const never = () => assert.fail('must stop before credentials, billing or dispatch');
    const dependencies = {
      getD1: () => d1, getDb: never, platformGitHubToken: never, dispatchGitHub: never,
      authenticatedAccount: async () => ({ userId: 'operator', dbUserId: null }),
      correlationIdFromRequest: () => 'cor_' + 'a'.repeat(32), CORRELATION_HEADER: 'x-atlas-correlation-id',
      resolveTenantContext: async () => ({ tenantId: 1, role: 'owner', principal: 'operator' }),
      tenantAllowlist: async () => new Set(['owner/repo']), allowedRepositories: () => new Set(['owner/repo']),
      validateTask: body => ({ task: body }), selfModificationDecision: () => ({ allowed: true }), taskStorageReadiness,
    };
    const { POST } = new Function(...Object.keys(dependencies), compiled + '; return { POST };')(...Object.values(dependencies));
    const response = await POST(new Request('https://atlas.test/api/tasks', { method: 'POST', body: JSON.stringify({ repository: 'owner/repo', branch: 'main', mode: 'coder', objective: 'fixture' }) }));
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.code, 'TASK_STORAGE_SCHEMA_MISSING');
    assert.match(result.message, /tasks.correlation_id.*Nothing was started/);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM conversations').get().n, 0);
  } finally { sqlite.close(); }
});
