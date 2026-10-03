import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Select a bounded, ascending range of checked-in migrations; never user SQL. */
export function selectMigrations(names, { from, through = '' }) {
  if (!/^\d{4}$/.test(from ?? '')) throw new Error('from_migration must be a four-digit prefix.');
  if (through !== '' && !/^\d{4}$/.test(through)) throw new Error('through_migration must be empty or a four-digit prefix.');
  if (through && through < from) throw new Error('through_migration must not precede from_migration.');
  const selected = names.filter(name => /^\d{4}_[a-zA-Z0-9_]+\.sql$/.test(name))
    .filter(name => name.slice(0, 4) >= from && (!through || name.slice(0, 4) <= through)).sort();
  if (!selected.length) throw new Error('No migrations match the requested range.');
  return selected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = selectMigrations(readdirSync('drizzle'), { from: process.env.FROM_MIGRATION, through: process.env.THROUGH_MIGRATION ?? '' });
    console.log(names.map(name => `drizzle/${name}`).join(' '));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
