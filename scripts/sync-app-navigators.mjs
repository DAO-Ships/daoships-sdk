import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
if (process.argv.slice(2).some(arg => !['--write', '--check'].includes(arg))) throw Error('Use --check or --write.');
// Verify every compiler input and SDK artifact before trusting any source for app sync.
execFileSync(process.execPath, [resolve(sdk, 'scripts/sync-navigators.mjs'), '--check'], { stdio: 'inherit' });
const kinds = ['OnboarderNavigator', 'ERC20TributeNavigator', 'NFTGatedNavigator', 'SignalNavigator', 'TimelockNavigator', 'VestingNavigator', 'BudgetNavigator', 'SubscriptionNavigator'];
const changed = [];
for (const kind of kinds) {
  const artifact = JSON.parse(readFileSync(resolve(sdk, `../daoships-contracts/artifacts/contracts/navigators/${kind}.sol/${kind}.json`), 'utf8'));
  const file = resolve(sdk, `../daoships-app/src/config/abi/${kind}.bytecode.ts`);
  const text = readFileSync(file, 'utf8');
  const matches = [...text.matchAll(/0x[\da-fA-F]{100,}/g)];
  if (matches.length !== 1) throw Error(`Expected one unambiguous creation bytecode in ${kind}.`);
  if (matches[0][0] === artifact.bytecode) continue;
  changed.push(kind);
  if (write) writeFileSync(file, text.replace(matches[0][0], artifact.bytecode));
}
if (changed.length && !write) throw Error(`App bytecode drift: ${changed.join(', ')}. Review source then run --write.`);
console.log(write ? `Updated ${changed.length} app creation artifacts: ${changed.join(', ') || 'none'}.` : 'All eight app creation artifacts match source-verified SDK artifacts.');
