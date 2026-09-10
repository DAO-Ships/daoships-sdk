import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

/** Development-only canonical input loading; never imported by runtime SDK modules. */
export async function loadAbiSources() {
  const source = new URL('../../daoships-app/src/config/abi/', import.meta.url);
  const files = (await readdir(source)).filter(name => name.endsWith('.json')).sort();
  const abis = {}, provenance = {};
  for (const file of files) {
    const raw = await readFile(new URL(file, source), 'utf8');
    const parsed = JSON.parse(raw);
    const abi = Array.isArray(parsed) ? parsed : parsed.abi;
    if (!Array.isArray(abi)) throw new Error(`Missing ABI in ${file}`);
    abis[file.replace(/\.json$/, '')] = abi;
    provenance[file] = createHash('sha256').update(raw).digest('hex');
  }
  const contracts = new URL('../../daoships-contracts/', import.meta.url);
  const location = new URL('artifacts/contracts/interfaces/IQuaiVaultFactory.sol/', contracts);
  const artifact = JSON.parse(await readFile(new URL('IQuaiVaultFactory.json', location), 'utf8'));
  const debug = JSON.parse(await readFile(new URL('IQuaiVaultFactory.dbg.json', location), 'utf8'));
  const build = JSON.parse(await readFile(new URL(debug.buildInfo, location), 'utf8'));
  const current = await readFile(new URL('contracts/interfaces/IQuaiVaultFactory.sol', contracts), 'utf8');
  assert.equal(build.input.sources[artifact.sourceName].content, current, 'Vault factory interface source is stale.');
  assert.deepEqual(build.output.contracts[artifact.sourceName].IQuaiVaultFactory.abi, artifact.abi, 'Vault factory ABI differs from compiler output.');
  abis.QuaiVaultFactory = artifact.abi;
  provenance['IQuaiVaultFactory.sol'] = createHash('sha256').update(current).digest('hex');
  return { abis, provenance };
}
