import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './check-release.mjs';
import { verifyReleaseArchive } from './pack-release.mjs';

// Invoked only by the release workflow. No token fallback or shell interpolation.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run publication through the configured npm trusted-publisher workflow.');
const { distTag } = await checkRelease(process.env, true);
const archive = await verifyReleaseArchive(process.env.DAOSHIPS_RELEASE_SHA256);
const result = spawnSync('npm', ['publish', archive, '--ignore-scripts', '--access', 'public', '--provenance', '--tag', distTag], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', stdio: 'inherit',
});
if (result.error || result.status !== 0) throw new Error('npm release command failed.');
