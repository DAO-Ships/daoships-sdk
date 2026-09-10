import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = resolve(sdk, '../daoships-contracts');
const appAbi = resolve(sdk, '../daoships-app/src/config/abi');
const kinds = ['OnboarderNavigator','ERC20TributeNavigator','NFTGatedNavigator','SignalNavigator','TimelockNavigator','VestingNavigator','BudgetNavigator','SubscriptionNavigator'];
const check = process.argv.includes('--check');
const json = path => JSON.parse(readFileSync(path,'utf8'));
const emit = (file, content) => {
  const path = resolve(sdk,'src',file);
  if (check) assert.equal(readFileSync(path,'utf8'),content,`${file} is out of sync; run node scripts/sync-navigators.mjs`);
  else writeFileSync(path,content);
};
const quote = value => `'${value}'`;
function type(param) {
  const t=param.type;
  if(t.endsWith('[]'))return `readonly ${type({...param,type:t.slice(0,-2)})}[]`;
  if (/^u?int/.test(t)) return 'bigint';
  if(t==='bool')return 'boolean';
  if(t==='address'||t==='string'||t.startsWith('bytes'))return 'string';
  throw Error(`Unsupported ABI type ${t}`);
}
const tuple = params => `readonly [${params.map((p,i)=>`${(p.name || `arg${i}`).replace(/^_+/,'')}: ${type(p)}`).join(', ')}]`;
const abis = Object.fromEntries(kinds.map(kind=>[kind,json(resolve(appAbi,`${kind}.json`))]));
let types='/** Canonical navigator signatures derived from the repository Solidity ABI artifacts. */\n';
types+=`export type NavigatorKind = ${kinds.map(quote).join(' | ')};\n`;
for(const category of ['DeployConfig','Reads','Writes','ReadResults']) {
  types+=`export interface Navigator${category} {\n`;
  for(const kind of kinds) {
    const abi=abis[kind];types+=`  ${kind}: {\n`;
    if(category==='DeployConfig') {
      for(const p of abi.find(f=>f.type==='constructor').inputs)types+=`    ${p.name.replace(/^_+/,'')}: ${type(p)};\n`;
    } else {
      const functions=abi.filter(f=>f.type==='function' && (['view','pure'].includes(f.stateMutability)===(category!=='Writes')));
      for(const f of functions) {
        const signature=`${f.name}(${f.inputs.map(p=>p.type).join(',')})`;
        const keys=[signature];if(functions.filter(other=>other.name===f.name).length===1)keys.push(f.name);
        const value=category==='ReadResults' ? (f.outputs.length===1 ? type(f.outputs[0]) : tuple(f.outputs)) : tuple(f.inputs);
        for(const key of keys)types+=`    ${quote(key)}: ${value};\n`;
      }
    }
    types+='  };\n';
  }
  types+='}\n';
}
emit('navigators-types.ts',types);
let bytecodes='/** Source-verified Solidity 0.8.22 creation artifacts from daoships-contracts/artifacts/.\n * Optional module: import @daoships/sdk/bytecode. See docs/coverage-navigators.md for provenance. */\nimport type { NavigatorKind } from "./navigators-types.js";\nimport type { Hex } from "./values.js";\nexport const NAVIGATOR_BYTECODES: Readonly<Record<NavigatorKind, Hex>> = {\n';
for(const kind of kinds) {
  const sourceName=`contracts/navigators/${kind}.sol`;
  const artifactPath=resolve(contracts,`artifacts/${sourceName}/${kind}.json`);
  const artifact=json(artifactPath),debug=json(artifactPath.replace(/\.json$/,'.dbg.json'));
  const build=json(resolve(dirname(artifactPath),debug.buildInfo));
  const compiled=build.output.contracts[sourceName][kind];
  const metadata=JSON.parse(compiled.metadata);
  assert.equal(build.solcLongVersion,'0.8.22+commit.4fc1097e','Review compiler change before updating artifacts.');
  for(const name of Object.keys(metadata.sources)) {
    const local=resolve(contracts,name), dependency=resolve(contracts,'node_modules',name);
    const current=readFileSync(existsSync(local)?local:dependency,'utf8');
    assert.equal(current,build.input.sources[name].content,`${kind}: stale compiler input ${name}`);
  }
  assert.deepEqual(artifact.abi,abis[kind],`${kind}: app ABI differs from compiled contract`);
  assert.equal(artifact.bytecode,`0x${compiled.evm.bytecode.object}`,`${kind}: artifact bytecode differs from compiler output`);
  bytecodes+=`  ${kind}: '${artifact.bytecode}',\n`;
}
bytecodes+='};\n';emit('navigator-bytecodes.ts',bytecodes);
console.log(`${check?'Verified':'Generated'} eight navigator signature maps and source-verified creation artifacts.`);
