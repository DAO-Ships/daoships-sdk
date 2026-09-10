import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDaoProfileUpdate } from '../dist/profile.js';
import { buildPosterContent, POSTER_TAGS } from '../dist/index.js';
const DAO = '0x0011111111111111111111111111111111111111';
const current = () => ({ name: 'DAO', description: 'Current', avatar: 'https://example.test/a.png', banner: 'https://example.test/b.png',
  theme: { mode: 'dark', primary: '#123' }, links: { home: 'https://example.test' }, tags: ['one', 'two'], chainId: 9 });

test('profile updates carry all latest-record-only fields while diffing materialized columns', () => {
  const state = current();
  assert.deepEqual(buildDaoProfileUpdate(DAO, state, { name: 'Renamed' }), {
    daoAddress: DAO, name: 'Renamed', banner: state.banner, theme: state.theme, links: state.links, tags: state.tags, chainId: 9,
  });
  const patch = buildDaoProfileUpdate(DAO, state, { banner: 'https://example.test/new.png' });
  assert.equal(patch.banner, 'https://example.test/new.png');
  for (const key of ['name', 'description', 'avatar']) assert.equal(Object.hasOwn(patch, key), false);
  for (const key of ['theme', 'links', 'tags', 'chainId']) assert.deepEqual(patch[key], state[key]);
});

test('profile clears preserve explicit null only for materialized fields and omit record-only fields', () => {
  const state = current();
  for (const key of ['name', 'description', 'avatar']) {
    const payload = buildDaoProfileUpdate(DAO, state, { [key]: null });
    assert.equal(payload[key], null);
    assert.equal(JSON.parse(buildPosterContent(POSTER_TAGS.DAO_PROFILE, payload))[key], null);
  }
  for (const key of ['banner', 'theme', 'links', 'tags', 'chainId']) {
    const payload = buildDaoProfileUpdate(DAO, state, { [key]: null });
    assert.equal(Object.hasOwn(payload, key), false);
    for (const other of ['banner', 'theme', 'links', 'tags', 'chainId'].filter(field => field !== key)) assert.deepEqual(payload[other], state[other]);
    assert.doesNotThrow(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, payload));
  }
  assert.deepEqual(buildDaoProfileUpdate(DAO, { banner: state.banner }, { banner: null }), { daoAddress: DAO });
  assert.deepEqual(buildDaoProfileUpdate(DAO, { name: 'DAO', banner: state.banner }, { name: null, banner: null }), { daoAddress: DAO, name: null });
});

test('profile no-change detection ignores object-key order and does not post carried fields alone', () => {
  const state = current();
  assert.equal(buildDaoProfileUpdate(DAO, state, {}), null);
  assert.equal(buildDaoProfileUpdate(DAO, state, { ...state }), null);
  assert.equal(buildDaoProfileUpdate(DAO, state, { name: undefined }), null);
  assert.equal(buildDaoProfileUpdate(DAO, { name: null }, { name: null, banner: null }), null);
  assert.equal(buildDaoProfileUpdate(DAO, state, { theme: { primary: '#123', mode: 'dark' } }), null);
  assert.notEqual(buildDaoProfileUpdate(DAO, state, { tags: ['two', 'one'] }), null);
});

test('profile output is detached and nested replacements do not mutate or merge input values', () => {
  const state = current(), patch = { links: { docs: 'https://example.test/docs' }, theme: { mode: 'light' } };
  const before = structuredClone(state), patchBefore = structuredClone(patch);
  const payload = buildDaoProfileUpdate(DAO, state, patch);
  assert.deepEqual(payload.links, patch.links); assert.deepEqual(payload.theme, patch.theme);
  payload.links.docs = 'https://changed.test'; payload.tags.push('three'); payload.theme.mode = 'dark';
  assert.deepEqual(state, before); assert.deepEqual(patch, patchBefore);
});

test('profile rejects unknown fields, unsafe values, accessors and inherited records', () => {
  const bad = [{ unknown: true }, { daoAddress: DAO }, { schemaVersion: '1.0' }, { name: '' }, { banner: 'javascript:alert(1)' },
    { theme: { unknown: '#123' } }, { links: { home: 'javascript:alert(1)' } }, { chainId: 0 }, { tags: [1] }, { tags: ['x'.repeat(51)] },
    null, [], Object.create({ name: 'inherited' })];
  for (const input of bad) {
    assert.throws(() => buildDaoProfileUpdate(DAO, input, {}), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => buildDaoProfileUpdate(DAO, {}, input), { code: 'INVALID_ARGUMENT' });
  }
  let accessed = false;
  const getter = Object.defineProperty({}, 'name', { enumerable: true, get() { accessed = true; return 'name'; } });
  const nested = { links: Object.defineProperty({}, 'home', { enumerable: true, get() { accessed = true; return 'https://example.test'; } }) };
  for (const input of [getter, nested]) assert.throws(() => buildDaoProfileUpdate(DAO, {}, input), { code: 'INVALID_ARGUMENT' });
  assert.equal(accessed, false);
  assert.throws(() => buildDaoProfileUpdate('bad', {}, {}), { code: 'INVALID_ARGUMENT' });
});

test('profile uses Poster sanitation and aggregate byte limits for current, patch and merged result', () => {
  assert.deepEqual(buildDaoProfileUpdate(DAO, {}, { name: 'D\u0000AO' }), { daoAddress: DAO, name: 'DAO' });
  assert.equal(buildDaoProfileUpdate(DAO, { name: 'DAO' }, { name: 'D\u0000AO' }), null);
  assert.throws(() => buildDaoProfileUpdate(DAO, {}, { description: 'x'.repeat(1001) }), { code: 'INVALID_ARGUMENT' });
  const links = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['link' + i, 'https://example.test/' + 'x'.repeat(1900)]));
  assert.throws(() => buildDaoProfileUpdate(DAO, { links }, { banner: 'https://example.test/' + 'x'.repeat(1900) }), { code: 'INVALID_ARGUMENT' });
});
