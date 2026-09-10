import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface } from 'quais';
import ts from 'typescript';
import { CONTRACT_ABIS } from '../dist/abis.js';

// Optional development check. No sibling source/artifact access is imported by
// SDK runtime modules or required by the installed package.
const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = resolve(sdk, '../daoships-contracts');
const concrete = {
  DAOShip: 'core', DAOShipLauncher: 'core', DAOShipAndVaultLauncher: 'core',
  SharesERC20: 'tokens', LootERC20: 'tokens', Poster: 'tools',
  OnboarderNavigator: 'navigators', ERC20TributeNavigator: 'navigators', NFTGatedNavigator: 'navigators',
  SignalNavigator: 'navigators', TimelockNavigator: 'navigators', VestingNavigator: 'navigators',
  BudgetNavigator: 'navigators', SubscriptionNavigator: 'navigators',
};
assert.equal(Object.keys(concrete).length, 14);
const names = [...Object.keys(concrete), 'QuaiVault', 'QuaiVaultProxy', 'QuaiVaultFactory'].sort();
assert.deepEqual(Object.keys(CONTRACT_ABIS).sort(), names, 'Review any change to the 17 supported contract interfaces.');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const cache = new Map();
async function buildInfo(file) {
  if (!cache.has(file)) cache.set(file, await json(file));
  return cache.get(file);
}
const typeSource = ts.createSourceFile('contract-types.ts', await readFile(resolve(sdk, 'src/contract-types.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const typeInterfaces = new Map(typeSource.statements.filter(ts.isInterfaceDeclaration).map(node => [node.name.text, node]));
function mapKeys(interfaceName, name) {
  const parent = typeInterfaces.get(interfaceName);
  assert.ok(parent, `Missing ${interfaceName}`);
  const contract = parent.members.find(member => ts.isPropertySignature(member) && member.name.text === name);
  assert.ok(contract && ts.isTypeLiteralNode(contract.type), `${interfaceName} missing ${name}`);
  return contract.type.members.map(member => { assert.ok(ts.isPropertySignature(member)); return member.name.text; }).sort();
}

let functions = 0, events = 0;
for (const name of names) {
  const abi = new Interface(CONTRACT_ABIS[name]);
  for (const [fragmentKind, typeName] of [['function', 'ContractMethods'], ['event', 'ContractEvents']]) {
    const fragments = abi.fragments.filter(fragment => fragment.type === fragmentKind);
    const expected = fragments.flatMap(fragment => fragments.filter(other => other.name === fragment.name).length === 1
      ? [fragment.format('sighash'), fragment.name] : [fragment.format('sighash')]);
    assert.deepEqual(mapKeys(typeName, name), expected.sort(), `${name} ${typeName}: missing/stale/ambiguous generated keys`);
    if (fragmentKind === 'function') functions += fragments.length;
    else events += fragments.length;
  }
}

let declaredFunctions = 0, compiledMethods = 0, checkedSources = 0;
for (const [name, folder] of Object.entries(concrete)) {
  const sourceName = `contracts/${folder}/${name}.sol`;
  const artifactPath = resolve(contracts, 'artifacts', sourceName, `${name}.json`);
  let artifact;
  try { artifact = await json(artifactPath); }
  catch (cause) { throw new Error(`Optional source coverage requires sibling compiled artifacts: ${artifactPath}`, { cause }); }
  const debug = await json(artifactPath.replace(/\.json$/, '.dbg.json'));
  const build = await buildInfo(resolve(dirname(artifactPath), debug.buildInfo));
  const compiled = build.output.contracts[sourceName][name];
  assert.ok(compiled, `Missing compiler output for ${name}`);
  const metadata = JSON.parse(compiled.metadata);
  for (const dependencyName of Object.keys(metadata.sources)) {
    let current = resolve(contracts, dependencyName);
    try { await access(current); }
    catch { current = resolve(contracts, 'node_modules', dependencyName); }
    assert.equal(await readFile(current, 'utf8'), build.input.sources[dependencyName].content, `${name}: stale compiler dependency ${dependencyName}; rebuild contracts before auditing`);
    checkedSources++;
  }
  assert.deepEqual(artifact.abi, compiled.abi, `${name}: artifact differs from compiler ABI`);
  assert.deepEqual(CONTRACT_ABIS[name], compiled.abi, `${name}: SDK/app snapshot differs from current-source compiler ABI`);
  const abi = new Interface(CONTRACT_ABIS[name]);
  const methods = Object.fromEntries(abi.fragments.filter(fragment => fragment.type === 'function').map(fragment => [fragment.format('sighash'), fragment.selector.slice(2)]));
  assert.deepEqual(methods, compiled.evm.methodIdentifiers, `${name}: inherited methods/public getters missing or stale`);
  compiledMethods += Object.keys(methods).length;
  const ast = build.output.sources[sourceName].ast;
  const contract = ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === name);
  assert.ok(contract && contract.contractKind === 'contract' && contract.abstract === false, `${name} must be a concrete contract`);
  const declared = contract.nodes.filter(node => node.nodeType === 'FunctionDefinition' && node.kind === 'function' && ['public', 'external'].includes(node.visibility));
  for (const declaration of declared) {
    assert.ok(declaration.functionSelector, `${name}.${declaration.name}: missing compiler selector`);
    const candidates = Object.entries(methods).filter(([signature, selector]) => signature.startsWith(`${declaration.name}(`) && selector === declaration.functionSelector);
    assert.equal(candidates.length, 1, `${name}.${declaration.name}: public/external declaration is not represented unambiguously`);
  }
  declaredFunctions += declared.length;
}

console.log(`Source feature coverage verified: ${declaredFunctions} declared public/external functions across 14 concrete contracts; ${compiledMethods} compiled methods including inheritance/getters; ${checkedSources} source dependency checks.`);
console.log(`Generated coverage verified: ${functions} ABI functions and ${events} ABI events across all 17 interfaces, including full signatures and unambiguous aliases.`);
console.log('This proves current-source ABI/type-map representation, not workflow convenience completeness or live deployment correctness.');
