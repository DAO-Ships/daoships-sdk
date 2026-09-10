import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_ARCHIVE, saveReleaseArchive, verifyReleaseArchive } from '../scripts/pack-release.mjs';

test('release handoff preserves the exact tested bytes and rejects changed or unbounded artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daoships-release-test-'));
  try {
    const source = join(directory, 'tested.tgz'), outputFile = join(directory, 'github-output');
    const bytes = Buffer.from('Package bytes already tested by the isolated consumer.');
    await writeFile(source, bytes);
    const packed = { name: '@daoships/sdk', version: '0.1.0-alpha.0' };
    const options = { directory, outputFile };
    await assert.rejects(saveReleaseArchive(source, { ...packed, name: '@other/package' }, packed.version, options));
    await assert.rejects(saveReleaseArchive(source, packed, '0.2.0', options));
    const result = await saveReleaseArchive(source, packed, packed.version, options);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(await readFile(outputFile, 'utf8'), `sha256=${result.sha256}\n`);
    const archive = await verifyReleaseArchive(result.sha256, directory);
    assert.equal(archive, join(directory, RELEASE_ARCHIVE));
    assert.deepEqual(await readFile(archive), bytes);
    await assert.rejects(saveReleaseArchive(source, packed, packed.version, options), { code: 'EEXIST' });
    for (const digest of [undefined, '', '../archive', '0'.repeat(64)]) await assert.rejects(verifyReleaseArchive(digest, directory));
    await writeFile(archive, 'Tampered archive');
    await assert.rejects(verifyReleaseArchive(result.sha256, directory), /checksum/);
    await writeFile(archive, '');
    await assert.rejects(verifyReleaseArchive(result.sha256, directory), /bounded regular/);
    await truncate(archive, 32 * 1024 * 1024 + 1);
    await assert.rejects(verifyReleaseArchive(result.sha256, directory), /bounded regular/);
    await rm(archive);
    await symlink(source, archive);
    await assert.rejects(verifyReleaseArchive(result.sha256, directory), /bounded regular/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
