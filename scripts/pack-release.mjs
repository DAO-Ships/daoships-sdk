import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ARCHIVE = 'daoships-sdk.tgz';
export const RELEASE_DIRECTORY = fileURLToPath(new URL('../.release/', import.meta.url));
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

async function readArchive(path) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= MAX_ARCHIVE_BYTES, 'Expected a bounded regular release archive.');
  const bytes = await readFile(path);
  assert.equal(bytes.length, stat.size, 'Release archive changed while being read.');
  return bytes;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Called only after the isolated package consumer successfully tests this archive.
export async function saveReleaseArchive(source, packed, expectedVersion, {
  directory = RELEASE_DIRECTORY, outputFile = process.env.GITHUB_OUTPUT,
} = {}) {
  assert.equal(packed.name, '@daoships/sdk');
  assert.equal(packed.version, expectedVersion);
  assert.ok(typeof expectedVersion === 'string' && expectedVersion.length > 0);
  const bytes = await readArchive(source), digest = sha256(bytes);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, RELEASE_ARCHIVE), bytes, { flag: 'wx' });
  if (outputFile) await appendFile(outputFile, `sha256=${digest}\n`);
  return { archive: RELEASE_ARCHIVE, sha256: digest };
}

// Uses Node builtins only: the privileged publisher never imports SDK dependencies.
export async function verifyReleaseArchive(expectedSha256, directory = RELEASE_DIRECTORY) {
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/, 'Expected the validation job archive checksum.');
  const path = join(directory, RELEASE_ARCHIVE);
  assert.equal(sha256(await readArchive(path)), expectedSha256, 'Release archive checksum differs from the tested artifact.');
  return path;
}
