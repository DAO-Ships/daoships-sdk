import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseMetadata } from '../scripts/check-release.mjs';

const manifest = { name: '@daoships/sdk', version: '0.1.0-alpha.0', license: 'MIT', repository: { type: 'git', url: 'git+https://github.com/example/sdk.git' }, publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' } };
const context = { licenseText: 'License text supplied by the package owner and included in the archive.', ref: 'refs/tags/v0.1.0-alpha.0', repository: 'example/sdk' };
test('npm release validation ties the tag/repository to the manifest and keeps prereleases off latest', () => {
  assert.deepEqual(validateReleaseMetadata(manifest, context), { version: '0.1.0-alpha.0', distTag: 'alpha' });
  assert.equal(validateReleaseMetadata({ ...manifest, version: '1.0.0' }, { ...context, ref: 'refs/tags/v1.0.0' }).distTag, 'latest');
  assert.equal(validateReleaseMetadata({ ...manifest, version: '1.0.0-release-candidate.0' }, { ...context, ref: 'refs/tags/v1.0.0-release-candidate.0' }).distTag, 'release-candidate');
  for (const patch of [{ private: true }, { name: 'wrong' }, { license: 'UNLICENSED' }, { version: '01.0.0' }, { version: '1.0.0-alpha.01' }, { repository: { type: 'git', url: 'https://other.test' } }, { publishConfig: { access: 'restricted' } }]) assert.throws(() => validateReleaseMetadata({ ...manifest, ...patch }, context));
  for (const patch of [{ ref: 'refs/heads/main' }, { ref: 'refs/tags/v0.1.0' }, { repository: 'other/sdk' }, { licenseText: '' }]) assert.throws(() => validateReleaseMetadata(manifest, { ...context, ...patch }));
});

test('release metadata rejects npm semver-range tags and reserves latest for stable versions', () => {
  for (const channel of ['v1', 'v0', 'x', 'vx', 'latest']) {
    const version = `1.0.0-${channel}.0`;
    assert.throws(() => validateReleaseMetadata({ ...manifest, version }, { ...context, ref: `refs/tags/v${version}` }));
  }
});
