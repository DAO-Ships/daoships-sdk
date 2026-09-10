import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { indexerShapes, indexerRecordOrderingShape } from '../dist/indexer.js';

// Workspace-only drift check for the schema's existing one-column-per-line
// declaration format. Unsupported SQL fails for review rather than being skipped.
const schema = await readFile(new URL('../../daoships-indexer/supabase/migrations/schema.sql', import.meta.url), 'utf8');
const tables = new Map([...schema.matchAll(/CREATE TABLE IF NOT EXISTS %I\.ds_(\w+) \(([\s\S]*?)\n\s*\)'/g)].map(([, table, body]) => [table, body]));
const internalTables = ['processed_logs', 'navigator_sanction_intents'];
assert.deepEqual([...tables.keys()].filter(table => !internalTables.includes(table)).sort(), Object.keys(indexerShapes).sort(), 'Public indexer table coverage changed.');
let columns = 0;
function parseField(table, line) {
  const field = line.match(/^([a-z_][a-z0-9_]*)\s+(public\.ds_navigator_permission|VARCHAR\(\d+\)(?:\[\])?|TEXT(?:\[\])?|TIMESTAMPTZ|BOOLEAN|BIGINT(?:\[\])?|INTEGER|SERIAL|SMALLINT|NUMERIC\(\d+,\s*\d+\)(?:\[\])?|JSONB)(?=\s|,|$)(.*)$/);
  assert.ok(field, `Unsupported SQL declaration in ds_${table}: ${line}`);
  const [, name, type, rest] = field;
  const base = /^(BIGINT|NUMERIC)/.test(type) ? 'amount'
    : ['INTEGER', 'SERIAL', 'SMALLINT'].includes(type) ? 'integer'
    : type === 'BOOLEAN' ? 'boolean' : type === 'JSONB' ? 'json' : 'string';
  return [name, base + (type.endsWith('[]') ? '[]' : '') + (/NOT NULL|PRIMARY KEY/.test(rest.split('--')[0]) ? '' : '?')];
}
for (const [table, shape] of Object.entries(indexerShapes)) {
  const expected = {};
  for (const raw of tables.get(table).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--') || /^(CHECK|PRIMARY KEY|UNIQUE|FOREIGN KEY|CONSTRAINT)\b/.test(line)) continue;
    const [name, kind] = parseField(table, line);
    assert.ok(!Object.hasOwn(expected, name), `Duplicate column ds_${table}.${name}`);
    expected[name] = kind;
    columns++;
  }
  assert.deepEqual(table === 'records' ? { ...shape, ...indexerRecordOrderingShape } : shape, expected, `Public SQL projection/type/nullability drift: ds_${table}`);
}
for (const [, table, change] of schema.matchAll(/ALTER TABLE %I\.ds_(\w+) ((?:ADD|DROP|ALTER|RENAME) COLUMN[^'\n]*)/g)) {
  if (internalTables.includes(table)) continue;
  assert.ok(change.startsWith('ADD COLUMN IF NOT EXISTS '), `Review schema alteration in ds_${table}: ${change}`);
  const [name, kind] = parseField(table, change.slice('ADD COLUMN IF NOT EXISTS '.length));
  const shape = table === 'records' ? { ...indexerShapes.records, ...indexerRecordOrderingShape } : indexerShapes[table];
  assert.equal(shape?.[name], kind, `Additive migration drift: ds_${table}.${name}`);
}
console.log(`Indexer source coverage verified: ${Object.keys(indexerShapes).length} public tables, ${columns} columns including SQL numeric types, arrays and nullability.`);
