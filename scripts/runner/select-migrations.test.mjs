import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { selectMigrations } from './select-migrations.mjs';

const directory = new URL('../../apps/web/', import.meta.url);
const names = readdirSync(new URL('drizzle/', directory));
test('a bounded repair selects only the skipped migration, not installed later migrations', () => {
  assert.deepEqual(selectMigrations(names, { from: '0013', through: '0013' }), ['0013_task_correlation_id.sql']);
  assert.deepEqual(selectMigrations(names, { from: '0014' }), names.filter(name => /^\d{4}_/.test(name) && name.slice(0, 4) >= '0014').sort());
  assert.deepEqual(selectMigrations([...names].reverse(), { from: '0013', through: '0014' }), ['0013_task_correlation_id.sql', '0014_session_revocation.sql']);
});
test('invalid, inverted and empty ranges fail before any migration execution', () => {
  for (const range of [{ from: '*' }, { from: '0013', through: '../0015' }, { from: '0015', through: '0013' }, { from: '9999' }]) assert.throws(() => selectMigrations(names, range));
  assert.throws(() => selectMigrations(['0013_bad;command.sql', '../0013_bad.sql'], { from: '0013' }));
});
test('workflow selector entrypoint emits only bounded checked-in paths', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./select-migrations.mjs', import.meta.url))], {
    cwd: fileURLToPath(directory), encoding: 'utf8', env: { ...process.env, FROM_MIGRATION: '0013', THROUGH_MIGRATION: '0013' },
  }).trim();
  assert.equal(output, 'drizzle/0013_task_correlation_id.sql');
  const workflow = readFileSync(new URL('../../.github/workflows/migrate-d1.yml', import.meta.url), 'utf8');
  assert.match(workflow, /THROUGH_MIGRATION: \$\{\{ github\.event\.inputs\.through_migration \}\}/);
  assert.match(workflow, /node \.\.\/\.\.\/scripts\/runner\/select-migrations\.mjs/);
  assert.match(workflow, /dry_run != 'true'/);
});
