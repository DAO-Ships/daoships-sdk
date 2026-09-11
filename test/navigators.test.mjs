import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import { readFileSync } from 'node:fs';
import { CONTRACT_ABIS } from '../dist/abis.js';
import { Navigator, NAVIGATOR_KINDS, navigatorDeploymentArgs, encodeNavigatorDeployment, quoteOnboarder, quoteERC20Tribute } from '../dist/navigators.js';
import { buildAllowlistTree, getAllowlistProof, verifyAllowlistProof, verifyAllowlistRoot, parseAllowlistInput, isOpenAllowlist, ZERO_ALLOWLIST_ROOT } from '../dist/allowlist.js';
const A = '0x0011111111111111111111111111111111111111', B = '0x0022222222222222222222222222222222222222';
const ZERO = '0x' + '00'.repeat(20), ROOT = '0x' + '00'.repeat(32);
function sample(param) {
  if (param.baseType === 'array') return [sample(param.arrayChildren)];
  if (param.type === 'address') return A;
  if (param.type.startsWith('uint')) return 1n;
  if (param.type === 'bool') return true;
  if (param.type === 'string') return 'DAO Ships';
  if (param.type.startsWith('bytes')) return '0x' + '00'.repeat(Number(param.type.slice(5)) || 1);
  throw Error(param.type);
}
function argsFor(kind, method) {
  const args = method.inputs.map(sample);
  if (method.name === 'createPoll') args[1] = 2n;
  if (method.name === 'createBudget') {args[4] = 3600n; args[6] = 0n;}
  return args;
}
test('navigator reads use the zero sender by default for Orchard EOA validation', async () => {
  const iface = new Interface(CONTRACT_ABIS.OnboarderNavigator);
  const nav = new Navigator('OnboarderNavigator', A, { async call(request) {
    assert.equal(request.from, ZERO);
    assert.equal(request.to, A);
    return iface.encodeFunctionResult('daoShip', [B]);
  } });
  assert.equal(await nav.read('daoShip', []), B);
});
test('every canonical navigator mutation and read is available, overloads are unambiguous, and read block/sender are preserved', async () => {
  for (const kind of NAVIGATOR_KINDS) {
    const iface = new Interface(CONTRACT_ABIS[kind]);
    const nav = new Navigator(kind, A, { async call(request) {
      assert.equal(request.to, A); assert.equal(request.from, B); assert.equal(request.blockTag, 99);
      const f = iface.getFunction(request.data.slice(0, 10));
      return iface.encodeFunctionResult(f, f.outputs.map(sample));
    }});
    for (const f of iface.fragments.filter(f => f.type === 'function')) {
      const args = argsFor(kind, f);
      if (f.stateMutability === 'view' || f.stateMutability === 'pure') {
        const result = await nav.read(f.format(), args, { from: B, blockTag: 99 });
        assert.ok(result !== undefined);
      } else {
        const tx = nav.encode(f.format(), args);
        assert.equal(tx.to, A); assert.equal(tx.value, 0n); assert.equal(tx.data, iface.encodeFunctionData(f,args));
        assert.equal(tx.operation, f.format());
      }
    }
  }
});
test('all eight constructor configs encode in canonical ABI order', () => {
  for (const kind of NAVIGATOR_KINDS) {
    const iface = new Interface(CONTRACT_ABIS[kind]);
    const config = Object.fromEntries(iface.deploy.inputs.map(p => [p.name.replace(/^_/, ''), sample(p)]));
    if (kind === 'OnboarderNavigator') { config.shareMultiplier = 0n; config.lootMultiplier = 0n; }
    if (kind === 'NFTGatedNavigator') config.mintCap = 2n, config.perAddressCap = 2n;
    if (kind === 'TimelockNavigator') config.delay = 600n, config.expiryWindow = 3600n;
    if (kind === 'SubscriptionNavigator') config.periodDuration = 3600n;
    const args = navigatorDeploymentArgs(kind, config);
    assert.equal(encodeNavigatorDeployment(kind, '0x6000', config), '0x6000' + iface.encodeDeploy(args).slice(2));
  }
});
test('subscription invariants match Solidity: hourly minimum, 3650 days maximum, reward capped at 10%', () => {
  const cfg = { daoShip:A,tokens:[ZERO],feesPerPeriod:[1n],periodDuration:3600n,graceDuration:315360000n,startTime:0n,collectorRewardBps:1000n,burnOnCollect:true,initialMembers:[B],name:'Dues',description:'' };
  assert.doesNotThrow(()=>navigatorDeploymentArgs('SubscriptionNavigator',cfg));
  for (const patch of [{collectorRewardBps:1001n},{periodDuration:3599n},{periodDuration:315360001n},{tokens:[ZERO,ZERO],feesPerPeriod:[1n,1n]},{feesPerPeriod:[0n]},{initialMembers:[B,B]}]) assert.throws(()=>navigatorDeploymentArgs('SubscriptionNavigator',{...cfg,...patch}),{code:'INVALID_ARGUMENT'});
});
test('navigator rejects invalid ABI ranges, native value, poll option count and vesting cliff', () => {
  assert.throws(()=>new Navigator('SignalNavigator',A).encode('vote',[0n,256n]),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>new Navigator('SignalNavigator',A).encode('vote',[0n,1n],1n),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>new Navigator('SignalNavigator',A).encode('createPoll',['q',1n,0n,1n]),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>new Navigator('VestingNavigator',A).encode('createSchedule',[B,1n,0n,11n,10n,false]),{code:'INVALID_ARGUMENT'});
});
test('simulation preserves sender and value and surfaces failures without broadcasting', async () => {
  const nav = new Navigator('OnboarderNavigator', A, { async call(tx) { assert.equal(tx.from,B);assert.equal(tx.value,50n);assert.equal(tx.blockTag,9);return '0x'; } });
  const result = await nav.simulate('onboard()',[],B,50n,9);assert.equal(result.value,50n);
  const failed = new Navigator('OnboarderNavigator', A, { async call() { throw Error('paused'); } });
  await assert.rejects(failed.simulate('onboard()',[],B),{code:'CHAIN_ERROR'});
});
test('tribute quotes preserve bigint integer rounding, fixed price refunds and reject dust/overflow', () => {
  assert.deepEqual(quoteOnboarder({shareMultiplier:0n,lootMultiplier:0n,pricePerUnit:10n,sharesPerUnit:3n,lootPerUnit:2n,minTribute:100n},25n),{shares:6n,loot:4n,cost:20n,refund:5n});
  assert.deepEqual(quoteOnboarder({shareMultiplier:5000n,lootMultiplier:0n,pricePerUnit:0n,sharesPerUnit:0n,lootPerUnit:0n,minTribute:1n},3n),{shares:1n,loot:0n,cost:3n,refund:0n});
  assert.equal(quoteERC20Tribute(15n*10n**17n,10n**18n,3n,5n),9n);
  assert.throws(()=>quoteERC20Tribute(1n,0n,1n,0n),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>quoteERC20Tribute(2n**255n,0n,3n,0n),{code:'INVALID_ARGUMENT'});
});
test('allowlist roots, dumps and proofs match independent OpenZeppelin fixtures, including uneven trees', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/allowlists-standard-v1.json',import.meta.url)));
  for (const fixture of fixtures) {
    const dump = buildAllowlistTree(fixture.addresses);
    assert.deepEqual(dump,fixture.dump);
    fixture.addresses.forEach((account,i)=>{const proof=getAllowlistProof(dump,account);assert.deepEqual(proof,fixture.proofs[i]);assert.equal(verifyAllowlistProof(dump.tree[0],account,proof),true);});
    assert.equal(verifyAllowlistRoot(dump,dump.tree[0]),true);
    const corrupt=structuredClone(dump);corrupt.tree[0]=ROOT;assert.equal(verifyAllowlistRoot(corrupt,ROOT),false);
  }
});
test('allowlists validate shard, deduplicate members, reject corruption and preserve open semantics', () => {
  assert.equal(buildAllowlistTree([]),null);
  assert.equal(buildAllowlistTree([A,A]).values.length,1);
  assert.deepEqual(parseAllowlistInput(`${A},${A}\ninvalid\n0x1011111111111111111111111111111111111111`).invalid,['invalid','0x1011111111111111111111111111111111111111']);
  assert.equal(getAllowlistProof(buildAllowlistTree([A]),B),null);
  assert.equal(verifyAllowlistProof(ROOT,A,[]),false);
  assert.equal(isOpenAllowlist(ZERO_ALLOWLIST_ROOT),true);
  assert.throws(()=>isOpenAllowlist('0x0'),{code:'INVALID_ARGUMENT'});
  const corrupt=buildAllowlistTree([A,B]);corrupt.values[0].treeIndex=0;
  assert.throws(()=>getAllowlistProof(corrupt,A),{code:'INVALID_ARGUMENT'});
});
test('navigator deployment receipt authenticates emitter and expected DAO, deployer and kind', async () => {
  const {parseNavigatorDeploymentReceipt} = await import('../dist/navigators.js');
  const iface = new Interface(CONTRACT_ABIS.OnboarderNavigator);
  const event=iface.encodeEventLog('NavigatorDeployed',[A,B,'SignalNavigator','Polls','Community polls']);
  const receipt={status:1,logs:[{address:B,...event}]};
  assert.equal(parseNavigatorDeploymentReceipt(receipt,B,{daoShip:A,deployer:B,kind:'SignalNavigator'}).name,'Polls');
  assert.throws(()=>parseNavigatorDeploymentReceipt(receipt,A),{code:'MISSING_EVENT'});
  assert.throws(()=>parseNavigatorDeploymentReceipt(receipt,B,{kind:'BudgetNavigator'}),{code:'INVALID_RESPONSE'});
  assert.throws(()=>parseNavigatorDeploymentReceipt({...receipt,status:0},B),{code:'TX_REVERTED'});
});
test('bundled navigator bytecodes include all eight nonempty creation artifacts', async () => {
  const {NAVIGATOR_BYTECODES}=await import('../dist/navigator-bytecodes.js');
  assert.deepEqual(Object.keys(NAVIGATOR_BYTECODES).sort(), [...NAVIGATOR_KINDS].sort());
  for (const kind of NAVIGATOR_KINDS) assert.match(NAVIGATOR_BYTECODES[kind],/^0x[0-9a-f]{100,}$/);
});

test('navigator reads and simulations bound hanging providers and reject malformed responses', async () => {
  const hanging = new Navigator('OnboarderNavigator', A, { call: () => new Promise(() => {}) });
  await assert.rejects(hanging.read('daoShip', [], { timeoutMs: 5 }), { code: 'TIMEOUT' });
  await assert.rejects(hanging.simulate('onboard()', [], B, 1n, 99, { timeoutMs: 5 }), { code: 'TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const untouched = new Navigator('OnboarderNavigator', A, { async call() { calls++; return '0x'; } });
  await assert.rejects(untouched.read('daoShip', [], { signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(untouched.simulate('onboard()', [], B, 1n, 99, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(calls, 0);
  for (const raw of [null, '0xzz', '0x0', '0x' + '00'.repeat(33)]) {
    const bad = new Navigator('OnboarderNavigator', A, { async call() { return raw; } });
    await assert.rejects(bad.read('daoShip', [], { maxResponseBytes: 32 }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(bad.simulate('onboard()', [], B, 1n, undefined, { maxResponseBytes: 32 }), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(new Navigator('OnboarderNavigator', A, { async call() { return '0x'; } }).read('daoShip', []), { code: 'INVALID_RESPONSE' });
  const invalidUtf8 = '0x' + '20'.padStart(64, '0') + '01'.padStart(64, '0') + 'ff'.padEnd(64, '0');
  await assert.rejects(new Navigator('OnboarderNavigator', A, { async call() { return invalidUtf8; } }).read('navigatorType', []), { code: 'INVALID_RESPONSE' });
  const midflight = new AbortController();
  const pending = hanging.read('daoShip', [], { signal: midflight.signal });
  midflight.abort(); await assert.rejects(pending, { code: 'ABORTED' });
  await assert.rejects(untouched.read('daoShip', [], { timeoutMs: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(untouched.read('daoShip', [], { maxResponseBytes: 0 }), { code: 'INVALID_ARGUMENT' });
});
