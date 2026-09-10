import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, ZeroHash, keccak256, toUtf8Bytes, getAddress } from 'quais';
import { CONTRACT_ABIS } from '../dist/abis.js';
import { NAVIGATOR_KINDS } from '../dist/navigators.js';
import { stringify } from '../dist/values.js';
import { decodeProposal, hashProposalData } from '../dist/encoding.js';
import { buildDAOShipLaunchPlan, buildNavigatorDeploymentPlan, prepareDAOShipLaunch, assertDAOShipLaunchReceipt,
  pendingVaultSetupCalls, prepareDeploymentWorkflowStep, verifyDeploymentWorkflowStep, advanceDeploymentWorkflow, reconcileDeploymentWorkflowStep } from '../dist/deployment-workflows.js';
const addr = n => getAddress('0x00' + n.toString(16).padStart(38, '0'));
const A=addr(10), V=addr(11), DAO=addr(12), N=addr(13), TOKEN=addr(14), POSTER=addr(15);
const HASH='0x'+'aa'.repeat(32), OTHER='0x'+'bb'.repeat(32), BLOCK='0x'+'cc'.repeat(32);
const deployment=Object.fromEntries(['daoShipAndVaultLauncher','daoShipLauncher','quaiVaultFactory','multisendCallOnly','daoShipSingleton','sharesSingleton','lootSingleton','vaultSingleton'].map((key,i)=>[key,addr(i+20)]));
const params={ shareTokenName:'Shares',shareTokenSymbol:'S',lootTokenName:'Loot',lootTokenSymbol:'L',sharesSalt:1n,lootSalt:2n,daoShipSalt:3n,
  initialization:{multisendLibrary:deployment.multisendCallOnly,governanceConfig:{votingPeriod:60,gracePeriod:0,proposalOffering:0n,quorumPercent:0n,sponsorThreshold:1n,minRetentionPercent:0n,defaultExpiryWindow:0},
  navigators:[],navigatorPermissions:[],initMembers:[A],initShareAmounts:[10n],initLootAmounts:[20n],guildTokens:[ZeroAddress],pauseSharesOnLaunch:false,pauseLootOnLaunch:false}};
const launchInput=(route='direct')=>({chainId:9,from:A,addressPolicy:'evm',deployment,parameters:params,route,...(route==='new-vault'?{vaultOwners:[A],vaultThreshold:1n,vaultSalt:4n,vaultProxyBytecode:'0x6000'}:{existingVault:V})});
const launch=(route='direct')=>buildDAOShipLaunchPlan(launchInput(route));
function config(kind) {
  const base={daoShip:DAO,name:'Navigator',description:'Description'},cap={expiry:0n,mintCap:1000n,perAddressCap:100n,allowlistRoot:ZeroHash};
  return ({OnboarderNavigator:{...base,...cap,shareMultiplier:10000n,lootMultiplier:0n,pricePerUnit:0n,sharesPerUnit:0n,lootPerUnit:0n,minTribute:1n},
    ERC20TributeNavigator:{...base,...cap,tributeToken:TOKEN,pricePerShare:1n,pricePerLoot:0n},NFTGatedNavigator:{...base,...cap,gateToken:TOKEN,sharesPerHolder:1n,lootPerHolder:0n,requireTribute:false,tributeAmount:0n},
    SignalNavigator:{...base,minSharesToCreatePoll:1n,minDuration:60n,maxDuration:3600n,maxStartDelay:3600n},TimelockNavigator:{...base,delay:600n,expiryWindow:3600n},VestingNavigator:base,BudgetNavigator:base,
    SubscriptionNavigator:{...base,tokens:[ZeroAddress],feesPerPeriod:[1n],periodDuration:3600n,graceDuration:0n,startTime:0n,collectorRewardBps:0n,burnOnCollect:false,initialMembers:[]}})[kind];
}
const navInput=(kind='VestingNavigator',extra={})=>({chainId:9,from:A,addressPolicy:'evm',kind,config:config(kind),bytecode:'0x6000',expectedAddress:N,vault:V,
  ...(kind==='SignalNavigator'?{signalEndorsement:{poster:POSTER,currentNavigators:[{address:TOKEN,type:'BudgetNavigator'}]}}:{}),...extra});
const nav=(kind,extra)=>buildNavigatorDeploymentPlan(navInput(kind,extra));
const ifaces=Object.fromEntries(Object.entries(CONTRACT_ABIS).map(([name,abi])=>[name,new Interface(abi)]));
const event=(contract,address,name,args)=>({address,...ifaces[contract].encodeEventLog(ifaces[contract].getEvent(name),args)});
function receiptFor(plan,stepId) {
  const step=plan.steps.find(s=>s.id===stepId), logs=[];
  const receipt={hash:HASH,blockNumber:100,blockHash:BLOCK,status:1,logs};
  if(plan.type==='dao-launch' && stepId==='launch') {
    const p=plan.expected,d=plan.deployment;
    logs.push(event('DAOShipLauncher',d.daoShipLauncher,'LaunchDAOShip',[p.daoShip,p.shares,p.loot,p.vault,plan.route==='direct'?plan.from:d.daoShipAndVaultLauncher]));
    if(plan.route!=='direct') logs.push(event('DAOShipAndVaultLauncher',d.daoShipAndVaultLauncher,'LaunchDAOShipAndVault',[p.daoShip,p.vault,p.shares,p.loot,!!plan.newVault,plan.from]));
  } else if(plan.type==='navigator') {
    if(stepId==='create') {receipt.contractAddress=plan.expectedAddress;logs.push(event(plan.kind,plan.expectedAddress,'NavigatorDeployed',[DAO,A,plan.kind,plan.metadata.name,plan.metadata.description]));}
    if(step.kind==='dao-governance') logs.push(event('DAOShip',DAO,'ProcessProposal',[1n,true,false,A]));
    if(stepId==='activate' && plan.kind==='SignalNavigator') logs.push(event('Poster',POSTER,'NewPost',[V,plan.signalEndorsement.content,'daoships.dao.navigators']));
    if(stepId==='fund-treasury' && plan.treasuryFunding.token!==ZeroAddress) logs.push(event('SharesERC20',TOKEN,'Transfer',[A,V,plan.treasuryFunding.amount]));
  }
  return receipt;
}
function fixture(plan,stepId=plan.steps[0].id) {
  const receipt=receiptFor(plan,stepId),step=plan.steps.find(s=>s.id===stepId), calls=[];
  const state={deployed:false,module:true,allowed:true,permission:7n,overrides:{},codeOverrides:{},receipt,latest:100,network:9n};
  const tx={hash:HASH,chainId:9n,from:A,to:step.kind==='creation'?null:step.calls[0]?.to,data:step.creationData??step.calls[0]?.data,value:step.calls[0]?.value??0n};
  const targets={};
  if(plan.type==='dao-launch') {
    for(const [key,value] of Object.entries(plan.deployment)) targets[value]=({daoShipAndVaultLauncher:'DAOShipAndVaultLauncher',daoShipLauncher:'DAOShipLauncher',quaiVaultFactory:'QuaiVaultFactory'})[key]??'SharesERC20';
    targets[plan.expected.daoShip]='DAOShip'; targets[plan.expected.vault]='QuaiVault';targets[plan.expected.shares]='SharesERC20';targets[plan.expected.loot]='LootERC20';
  } else Object.assign(targets,{[DAO]:'DAOShip',[V]:'QuaiVault',[N]:plan.kind,[TOKEN]:'SharesERC20',[POSTER]:'Poster'});
  const provider={getNetwork:async()=>({chainId:state.network}),getBlock:async(_s,tag)=>({hash:BLOCK,woHeader:{number:tag==='latest'?state.latest:tag}}),
    getCode:async a=>state.codeOverrides[a]??((plan.type==='dao-launch'?Object.entries(plan.expected).filter(([k])=>k!=='vault'||plan.newVault).map(([,v])=>v):[N]).includes(a)&&!state.deployed?'0x':'0x6000'),
    getTransactionReceipt:async()=>state.receipt,getTransaction:async()=>tx,
    call:async request=>{
      calls.push(request); assert.equal(request.blockTag,100);
      const iface=ifaces[targets[request.to]], f=iface?.parseTransaction(request);
      if(!f||f.fragment.stateMutability!=='view') return '0x';
      let result;
      const values={...deployment,avatar:plan.type==='dao-launch'?plan.expected.vault:V,sharesToken:plan.expected?.shares,lootToken:plan.expected?.loot,
        ...params.initialization.governanceConfig,isModuleEnabled:state.module,delegatecallAllowed:state.allowed,predictWalletAddress:plan.expected?.vault,
        getOwners:[A],threshold:1n,minExecutionDelay:0n,daoShip:DAO,navigatorType:plan.kind,navigators:state.permission,
        name:request.to===plan.expected?.loot?'Loot':'Shares',symbol:request.to===plan.expected?.loot?'L':'S',totalSupply:request.to===plan.expected?.loot?20n:10n};
      if(f.name==='proposals') result=[1n,A,0n,0n,A,0n,0n,0n,0n,0n,hashProposalData(plan.steps.find(s=>s.id==='activate').proposalData),0n,0n,0n,0n,''];
      else result=[values[f.name]];
      if(Object.hasOwn(state.overrides,f.name)) result=state.overrides[f.name];
      return iface.encodeFunctionResult(f.fragment,result);
    }};
  return {provider,state,tx,calls,receipt};
}
function memoryStore(initial=null) {
  let value=structuredClone(initial), swaps=0;
  return {load:async()=>structuredClone(value),compareAndSwap:async(_id,revision,next)=>{swaps++;if((value?.revision??null)!==revision)return false;value=structuredClone(next);return true;},get swaps(){return swaps;}};
}
const cp=(plan,steps,revision=1)=>({version:1,planId:plan.id,revision,steps});
const invalid={code:'INVALID_ARGUMENT'},changed={code:'PLAN_CHANGED'},response={code:'INVALID_RESPONSE'};

test('three immutable launch routes encode actual sender-sensitive predictions and all eight concrete navigator activation paths',()=>{
  const plans=['direct','existing-vault','new-vault'].map(launch);
  assert.notEqual(plans[0].expected.daoShip,plans[1].expected.daoShip);assert.equal(plans[1].expected.daoShip,plans[2].expected.daoShip);
  assert.deepEqual(plans.map(p=>p.steps.length),[3,3,1]);assert.equal(Object.isFrozen(plans[0].parameters.initialization.initMembers),true);
  for(const kind of NAVIGATOR_KINDS){const p=nav(kind);assert.equal(p.steps.length,2);assert.equal(p.steps[1].kind,'dao-governance');}
  assert.equal(nav('BudgetNavigator',{treasuryFunding:{token:ZeroAddress,amount:3n}}).steps[2].calls[0].value,3n);
  assert.equal(nav('BudgetNavigator',{treasuryFunding:{token:TOKEN,amount:3n}}).steps[2].calls[0].to,TOKEN);
});
test('plans reject malformed identities, routes, ownership, conflicting metadata and funding before execution',()=>{
  for(const patch of [{chainId:0},{addressPolicy:'other'},{from:ZeroAddress},{from:'0x01'+'00'.repeat(19),addressPolicy:'cyprus1'},{route:'unknown'},
    {parameters:{...params,initialization:{...params.initialization,multisendLibrary:A}}}]) assert.throws(()=>buildDAOShipLaunchPlan({...launchInput(),...patch}),invalid);
  for(const patch of [{vaultOwners:[]},{vaultOwners:Array(21).fill(A)},{vaultOwners:[A,A]},{vaultThreshold:2n}])assert.throws(()=>buildDAOShipLaunchPlan({...launchInput('new-vault'),...patch}),invalid);
  for(const patch of [{bytecode:'00'},{bytecode:'0x'+'00'.repeat(1048577)},{treasuryFunding:{token:TOKEN,amount:0n}},{treasuryFunding:{token:'broken',amount:1n}}])assert.throws(()=>buildNavigatorDeploymentPlan(navInput('VestingNavigator',patch)),invalid);
  assert.throws(()=>buildNavigatorDeploymentPlan(navInput('SignalNavigator',{signalEndorsement:undefined})),invalid);
  assert.throws(()=>buildNavigatorDeploymentPlan(navInput('SignalNavigator',{signalEndorsement:{poster:POSTER,currentNavigators:[{address:N}]}})),invalid);
});
test('Budget activation uses a DAO proposal containing the vault self-call, never a vault-owner executor',async()=>{
  const plan=nav('BudgetNavigator'),step=plan.steps[1];
  assert.equal(step.kind,'dao-governance');
  const [call]=decodeProposal(step.proposalData);
  assert.equal(call.to,V);assert.equal(call.value,0n);assert.equal(call.operation,0);
  assert.equal(call.data,ifaces.QuaiVault.encodeFunctionData('enableModule',[N]));
  assert.equal(step.calls[0].data,call.data);
  const creation=fixture(plan),activation=fixture(plan,'activate');creation.state.deployed=true;activation.state.module=false;
  const activationReceipt={...activation.receipt,hash:OTHER};
  const provider={...creation.provider,call:activation.provider.call,getTransactionReceipt:async hash=>hash===HASH?creation.receipt:activationReceipt};
  const store=memoryStore(cp(plan,{create:{status:'verified',hash:HASH}}));let executions=0;
  const executors={'dao-governance':{execute:async(_plan,_step,ctx)=>{
    executions++;assert.equal(ctx.prepared.alreadySatisfied,false);
    assert.deepEqual(ctx.prepared.calls,step.calls);
    activation.state.module=true;await ctx.onSubmitted(OTHER);return activationReceipt;
  }},vault:{execute:async()=>{assert.fail('Budget activation must not ask vault owners to execute');}}};
  assert.equal((await advanceDeploymentWorkflow(plan,store,executors,provider)).steps.activate.status,'verified');
  await advanceDeploymentWorkflow(plan,store,{},provider);assert.equal(executions,1);
  // A legacy owner-execution plan is different authority/data, not a checkpoint migration.
  const legacy=structuredClone(plan);legacy.steps[1].kind='vault';delete legacy.steps[1].proposalData;
  const {id,...body}=legacy;legacy.id=keccak256(toUtf8Bytes(stringify(body)));
  await assert.rejects(prepareDeploymentWorkflowStep(legacy,'activate',provider),changed);
});
test('Budget completion requires the exact successfully executed DAO proposal even if its module is already enabled',async()=>{
  const plan=nav('BudgetNavigator'),f=fixture(plan,'activate');
  f.state.receipt={...f.receipt,logs:[event('QuaiVault',V,'EnabledModule',[N])]};
  await assert.rejects(verifyDeploymentWorkflowStep(plan,'activate',f.receipt,f.provider),{code:'MISSING_EVENT'});
  f.state.receipt=f.receipt;
  f.state.overrides.proposals=[1n,A,0n,0n,A,0n,0n,0n,0n,0n,ZeroHash,0n,0n,0n,0n,''];
  await assert.rejects(verifyDeploymentWorkflowStep(plan,'activate',f.receipt,f.provider),response);
  delete f.state.overrides.proposals;
  f.state.receipt={...f.receipt,logs:[event('DAOShip',DAO,'ProcessProposal',[1n,true,true,A])]};
  await assert.rejects(verifyDeploymentWorkflowStep(plan,'activate',f.receipt,f.provider),{code:'ACTION_FAILED'});
  f.state.receipt=f.receipt;await verifyDeploymentWorkflowStep(plan,'activate',f.receipt,f.provider);
});
test('entry points reconstruct plans and capture mutable caller data before provider awaits',async()=>{
  const plan=launch(),f=fixture(plan),mutable=structuredClone(plan);
  const prepare=prepareDAOShipLaunch(mutable,f.provider);mutable.call.to=A;mutable.steps[0].calls[0].data='0x';
  assert.equal((await prepare).to,plan.call.to);
  const forged=structuredClone(plan);forged.call.to=A;const {id,...body}=forged;forged.id=keccak256(toUtf8Bytes(stringify(body)));
  await assert.rejects(prepareDAOShipLaunch(forged,f.provider),changed);
  await assert.rejects(prepareDeploymentWorkflowStep({...plan,type:'bad'},'launch',f.provider),invalid);
  await assert.rejects(prepareDAOShipLaunch({...plan,fn:()=>0},f.provider),invalid);
  await assert.rejects(prepareDAOShipLaunch({...launch('new-vault'),newVault:undefined},f.provider),invalid);
});
test('launch preparation pins factory references, vacant predictions and exact simulation for every route',async()=>{
  for(const route of ['direct','existing-vault','new-vault']){const p=launch(route),f=fixture(p),prepared=await prepareDAOShipLaunch(p,f.provider);assert.equal(prepared.data,p.call.data);assert.equal(prepared.checkedAt.blockHash,BLOCK);assert.ok(f.calls.every(c=>c.blockTag===100));}
  {const p=launch(),f=fixture(p);assert.equal((await prepareDeploymentWorkflowStep(p,'launch',f.provider)).transaction.data,p.call.data);}
  for(const [route,key,result] of [['direct','daoShipSingleton',[A]],['existing-vault','quaiVaultFactory',[A]],['new-vault','predictWalletAddress',[A]]]){const p=launch(route),f=fixture(p);f.state.overrides[key]=result;await assert.rejects(prepareDAOShipLaunch(p,f.provider),changed);}
  const p=launch(),f=fixture(p);f.state.deployed=true;await assert.rejects(prepareDAOShipLaunch(p,f.provider),changed);f.state.deployed=false;f.state.codeOverrides[deployment.daoShipSingleton]='0x';await assert.rejects(prepareDAOShipLaunch(p,f.provider),response);
});
test('provider bounds, aborts, deadlines, malformed blocks and chain changes are stable machine-readable errors',async()=>{
  const p=launch(),f=fixture(p);
  for(const options of [{timeoutMs:0},{maxResponseBytes:0},{maxResponseBytes:Infinity},{maxResponseBytes:16777217}])await assert.rejects(prepareDAOShipLaunch(p,f.provider,options),invalid);
  await assert.rejects(prepareDAOShipLaunch(p,{...f.provider,getNetwork:()=>new Promise(()=>{})},{timeoutMs:2}),{code:'TIMEOUT'});
  await assert.rejects(prepareDAOShipLaunch(p,{...f.provider,getNetwork:async()=>{throw Error('offline');}}),{code:'CHAIN_ERROR'});
  await assert.rejects(prepareDAOShipLaunch(p,f.provider,{signal:AbortSignal.abort()}),{code:'ABORTED'});
  const controller=new AbortController();const promise=prepareDAOShipLaunch(p,{...f.provider,getNetwork:()=>new Promise(()=>{})},{signal:controller.signal});controller.abort();await assert.rejects(promise,{code:'ABORTED'});
  f.state.network=10n;await assert.rejects(prepareDAOShipLaunch(p,f.provider),{code:'CHAIN_MISMATCH'});f.state.network=9n;
  for(const block of [null,{hash:'0x11'},{hash:BLOCK},{hash:BLOCK,woHeader:{number:-1}}])await assert.rejects(prepareDAOShipLaunch(p,{...f.provider,getBlock:async()=>block}),response);
  let count=0;await assert.rejects(prepareDAOShipLaunch(p,{...f.provider,getBlock:async()=>({hash:++count===1?BLOCK:OTHER,woHeader:{number:100}})}),response);
  for(const code of ['0x1','no',null,'0x'+'00'.repeat(4)]){f.state.codeOverrides[deployment.daoShipSingleton]=code;const prov={...f.provider,getCode:async()=>code};await assert.rejects(prepareDAOShipLaunch(p,prov,{maxResponseBytes:3}),response);}
});
test('launch receipt assertions reject missing, duplicated, foreign and mismatching factory evidence',()=>{
  for(const route of ['direct','existing-vault','new-vault']){const p=launch(route),r=receiptFor(p,'launch');assert.deepEqual(assertDAOShipLaunchReceipt(p,r),p.expected);
    assert.throws(()=>assertDAOShipLaunchReceipt(p,{...r,logs:[]}),{code:'MISSING_EVENT'});
    assert.throws(()=>assertDAOShipLaunchReceipt(p,{...r,logs:[...r.logs,r.logs[0]]}),{code:'MISSING_EVENT'});
    const wrong=structuredClone(r);wrong.logs[0]=event('DAOShipLauncher',p.deployment.daoShipLauncher,'LaunchDAOShip',[p.expected.daoShip,p.expected.shares,p.expected.loot,A,p.from]);assert.throws(()=>assertDAOShipLaunchReceipt(p,wrong),response);
    if(route!=='direct'){assert.throws(()=>assertDAOShipLaunchReceipt(p,{...r,logs:r.logs.slice(0,1)}),{code:'MISSING_EVENT'});const bad=structuredClone(r);bad.logs[1]=event('DAOShipAndVaultLauncher',p.deployment.daoShipAndVaultLauncher,'LaunchDAOShipAndVault',[p.expected.daoShip,p.expected.vault,p.expected.shares,p.expected.loot,!p.newVault,A]);assert.throws(()=>assertDAOShipLaunchReceipt(p,bad),response);}}
});
test('DAO receipt verification checks source receipt, canonical block, exact transaction, governance and token/vault postconditions',async()=>{
  for(const route of ['direct','existing-vault','new-vault']){const p=launch(route),f=fixture(p);await verifyDeploymentWorkflowStep(p,'launch',f.receipt,f.provider);}
  const p=launch(),f=fixture(p);
  for(const patch of [{status:0},{status:null},{blockNumber:-1},{hash:'0x11'}])await assert.rejects(verifyDeploymentWorkflowStep(p,'launch',{...f.receipt,...patch},f.provider));
  await assert.rejects(verifyDeploymentWorkflowStep(p,'unknown',f.receipt,f.provider),invalid);
  f.state.latest=99;await assert.rejects(verifyDeploymentWorkflowStep(p,'launch',f.receipt,f.provider),response);f.state.latest=100;
  await assert.rejects(verifyDeploymentWorkflowStep(p,'launch',f.receipt,{...f.provider,getBlock:async(_s,tag)=>tag==='latest'?{hash:BLOCK,woHeader:{number:100}}:null}),response);
  for(const patch of [{blockHash:OTHER},{hash:OTHER},{status:0},{blockNumber:99}]){f.state.receipt={...f.receipt,...patch};await assert.rejects(verifyDeploymentWorkflowStep(p,'launch',f.receipt,f.provider),response);}f.state.receipt=f.receipt;
  for(const patch of [{from:V},{chainId:10n},{hash:OTHER},{to:V},{data:'0x'},{value:1n}])await assert.rejects(verifyDeploymentWorkflowStep(p,'launch',f.receipt,{...f.provider,getTransaction:async()=>({...f.tx,...patch})}),response);
  for(const [name,result] of [['avatar',[A]],['votingPeriod',[61n]],['totalSupply',[999n]],['name',['Wrong']],['symbol',['Wrong']]]){f.state.overrides[name]=result;await assert.rejects(verifyDeploymentWorkflowStep(p,'launch',f.receipt,f.provider),response);delete f.state.overrides[name];}
  const np=launch('new-vault'),nf=fixture(np);for(const [name,result] of [['getOwners',[[V]]],['threshold',[2n]],['minExecutionDelay',[1n]],['isModuleEnabled',[false]]]){nf.state.overrides[name]=result;await assert.rejects(verifyDeploymentWorkflowStep(np,'launch',nf.receipt,nf.provider),response);delete nf.state.overrides[name];}
});
test('vault setup and navigator step refreshes use current prerequisites without confusing proposal receipt with execution',async()=>{
  const p=launch(),f=fixture(p);assert.deepEqual(await pendingVaultSetupCalls(p,f.provider,{blockTag:100}),[]);f.state.module=false;f.state.allowed=false;
  assert.equal((await pendingVaultSetupCalls(p,f.provider,{blockTag:100})).length,2);assert.equal((await prepareDeploymentWorkflowStep(p,'enable-dao-module',f.provider)).alreadySatisfied,false);
  await assert.rejects(pendingVaultSetupCalls(p,f.provider,{blockTag:'latest'}),invalid);
  await assert.rejects(verifyDeploymentWorkflowStep(p,'enable-dao-module',f.receipt,f.provider),response);await assert.rejects(verifyDeploymentWorkflowStep(p,'allow-multisend',f.receipt,f.provider),response);
  f.state.module=true;f.state.allowed=true;assert.equal((await prepareDeploymentWorkflowStep(p,'allow-multisend',f.provider)).alreadySatisfied,true);
  for(const kind of NAVIGATOR_KINDS){const n=nav(kind),nf=fixture(n);await prepareDeploymentWorkflowStep(n,'create',nf.provider);nf.state.deployed=true;await prepareDeploymentWorkflowStep(n,'activate',nf.provider);}
  const n=nav('BudgetNavigator',{treasuryFunding:{token:ZeroAddress,amount:2n}}),nf=fixture(n);assert.equal((await prepareDeploymentWorkflowStep(n,'activate',nf.provider)).alreadySatisfied,true);assert.equal((await prepareDeploymentWorkflowStep(n,'fund-treasury',nf.provider)).transaction.value,2n);
  for(const [name,result] of [['avatar',[A]],['daoShip',[V]],['navigatorType',['Wrong']]]){nf.state.overrides[name]=result;await assert.rejects(prepareDeploymentWorkflowStep(n,'activate',nf.provider),changed);delete nf.state.overrides[name];}
  nf.state.codeOverrides[DAO]='0x';await assert.rejects(prepareDeploymentWorkflowStep(n,'create',nf.provider),response);delete nf.state.codeOverrides[DAO];nf.state.deployed=true;await assert.rejects(prepareDeploymentWorkflowStep(n,'create',nf.provider),changed);
});
test('navigator receipts verify creation identity, successful exact governance action, vault module and funding logs',async()=>{
  for(const kind of NAVIGATOR_KINDS){const n=nav(kind),f=fixture(n);f.state.deployed=true;await verifyDeploymentWorkflowStep(n,'create',f.receipt,f.provider);const af=fixture(n,'activate');await verifyDeploymentWorkflowStep(n,'activate',af.receipt,af.provider);}
  const n=nav(),f=fixture(n);f.state.deployed=true;
  for(const patch of [{contractAddress:null},{contractAddress:V},{logs:[]}]){f.state.receipt={...f.receipt,...patch};await assert.rejects(verifyDeploymentWorkflowStep(n,'create',f.receipt,f.provider));}f.state.receipt=f.receipt;
  for(const patch of [{to:V},{data:'0x'},{value:1n}])await assert.rejects(verifyDeploymentWorkflowStep(n,'create',f.receipt,{...f.provider,getTransaction:async()=>({...f.tx,...patch})}),response);
  f.state.deployed=false;await assert.rejects(verifyDeploymentWorkflowStep(n,'create',f.receipt,f.provider),response);
  const af=fixture(n,'activate');af.state.permission=0n;await assert.rejects(verifyDeploymentWorkflowStep(n,'activate',af.receipt,af.provider),response);af.state.permission=7n;
  af.state.receipt={...af.receipt,logs:[]};await assert.rejects(verifyDeploymentWorkflowStep(n,'activate',af.receipt,af.provider),{code:'MISSING_EVENT'});af.state.receipt=af.receipt;
  af.state.overrides.proposals=[1n,A,0n,0n,A,0n,0n,0n,0n,0n,ZeroHash,0n,0n,0n,0n,''];await assert.rejects(verifyDeploymentWorkflowStep(n,'activate',af.receipt,af.provider),response);
  const b=nav('BudgetNavigator'),bf=fixture(b,'activate');bf.state.module=false;await assert.rejects(verifyDeploymentWorkflowStep(b,'activate',bf.receipt,bf.provider),response);
  const s=nav('SignalNavigator'),sf=fixture(s,'activate');sf.state.receipt={...sf.receipt,logs:sf.receipt.logs.slice(0,1)};await assert.rejects(verifyDeploymentWorkflowStep(s,'activate',sf.receipt,sf.provider),response);
  for(const token of [TOKEN,ZeroAddress]){const funded=nav('BudgetNavigator',{treasuryFunding:{token,amount:2n}}),ff=fixture(funded,'fund-treasury');await verifyDeploymentWorkflowStep(funded,'fund-treasury',ff.receipt,ff.provider);if(token===TOKEN){ff.state.receipt={...ff.receipt,logs:[]};await assert.rejects(verifyDeploymentWorkflowStep(funded,'fund-treasury',ff.receipt,ff.provider),response);}}
});
test('durable runner claims before sending, persists hash before waiting and resumes without executor broadcasts',async()=>{
  const p=nav(),f=fixture(p),store=memoryStore();let sends=0;
  const executor={execute:async(_p,_s,ctx)=>{sends++;assert.equal((await store.load()).steps.create.status,'submitting');assert.equal(ctx.id,`${p.id}:create`);await ctx.onSubmitted(HASH);assert.equal((await store.load()).steps.create.status,'submitted');f.state.deployed=true;return f.receipt;}};
  assert.equal((await advanceDeploymentWorkflow(p,store,{creation:executor},f.provider)).steps.create.status,'verified');assert.equal(sends,1);
  const resumed=memoryStore(cp(p,{create:{status:'submitted',hash:HASH}}));await advanceDeploymentWorkflow(p,resumed,{},f.provider);assert.equal((await resumed.load()).steps.create.status,'verified');
  const pending=memoryStore(cp(p,{create:{status:'submitted',hash:HASH}}));await assert.rejects(advanceDeploymentWorkflow(p,pending,{}, {...f.provider,getTransactionReceipt:async()=>null}),{code:'TX_PENDING'});
  await assert.rejects(advanceDeploymentWorkflow(p,memoryStore(cp(p,{create:{status:'submitting'}})),{creation:executor},f.provider),{code:'TX_PENDING'});
});
test('atomic workflow claim prevents concurrent duplicate sends and records uncertain failed broadcasts',async()=>{
  const p=nav(),f=fixture(p),store=memoryStore();let sends=0;
  const execute=async(_p,_s,ctx)=>{sends++;await ctx.onSubmitted(HASH);f.state.deployed=true;return f.receipt;};
  const results=await Promise.allSettled([advanceDeploymentWorkflow(p,store,{creation:{execute}},f.provider),advanceDeploymentWorkflow(p,store,{creation:{execute}},f.provider)]);
  assert.equal(sends,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'PERSISTENCE_ERROR');
  f.state.deployed=false;const failed=memoryStore();await assert.rejects(advanceDeploymentWorkflow(p,failed,{creation:{execute:async()=>{throw Error('lost broadcast ACK');}}},f.provider));assert.equal((await failed.load()).steps.create.status,'submitting');
  await assert.rejects(advanceDeploymentWorkflow(p,failed,{creation:{execute}},f.provider),{code:'TX_PENDING'});assert.equal(sends,1);
});
test('runner rejects malformed, out-of-order or forged checkpoints and invalid executor acknowledgments',async()=>{
  const p=nav(),f=fixture(p);
  const bad=[{...cp(p,{}),version:2},cp(p,42),cp(p,{wrong:{status:'verified',hash:HASH}}),cp(p,{create:{status:'bad'}}),cp(p,{create:{status:'submitted',hash:'no'}}),cp(p,{create:{status:'verified'}}),cp(p,{activate:{status:'submitted',hash:HASH}}),cp(p,{create:{status:'submitted'}}),cp(p,{create:{status:'verified',checkedAt:{blockNumber:100,blockHash:BLOCK}}}),{...cp(p,{}),blob:'x'.repeat(17000)}];
  for(const record of bad)await assert.rejects(advanceDeploymentWorkflow(p,memoryStore(record),{},f.provider),invalid);
  await assert.rejects(advanceDeploymentWorkflow(p,memoryStore(),{},f.provider),invalid);
  for(const behavior of ['missing','invalid','duplicate','receipt']){const store=memoryStore();await assert.rejects(advanceDeploymentWorkflow(p,store,{creation:{execute:async(_p,_s,ctx)=>{if(behavior==='invalid')await ctx.onSubmitted('no');else if(behavior!=='missing'){await ctx.onSubmitted(HASH);if(behavior==='duplicate')await ctx.onSubmitted(OTHER);}return {...f.receipt,hash:behavior==='receipt'?OTHER:HASH};}}},f.provider));}
  const exhausted=memoryStore(cp(p,{},Number.MAX_SAFE_INTEGER));await assert.rejects(advanceDeploymentWorkflow(p,exhausted,{creation:{execute:async()=>f.receipt}},f.provider),{code:'PERSISTENCE_ERROR'});
});
test('lost acknowledgment reconciliation requires matching mined evidence and CAS, then allows normal dependency advance',async()=>{
  const p=nav('BudgetNavigator'),f=fixture(p),store=memoryStore(cp(p,{create:{status:'submitting'}}));f.state.deployed=true;
  const reconciled=await reconcileDeploymentWorkflowStep(p,store,'create',HASH,f.provider);assert.equal(reconciled.steps.create.status,'verified');
  await advanceDeploymentWorkflow(p,store,{'dao-governance':{execute:async()=>{throw Error('already satisfied');}}},f.provider);assert.equal((await store.load()).steps.activate.status,'verified');
  await advanceDeploymentWorkflow(p,store,{},f.provider);
  f.state.module=false;await assert.rejects(advanceDeploymentWorkflow(p,store,{},f.provider),changed);f.state.module=true;
  const fresh=()=>memoryStore(cp(p,{create:{status:'submitting'}}));
  await assert.rejects(reconcileDeploymentWorkflowStep(p,fresh(),'create',OTHER,f.provider),response);
  await assert.rejects(reconcileDeploymentWorkflowStep(p,fresh(),'create',HASH,{...f.provider,getTransactionReceipt:async()=>null}),{code:'TX_PENDING'});
  await assert.rejects(reconcileDeploymentWorkflowStep(p,{...fresh(),compareAndSwap:async()=>false},'create',HASH,f.provider),{code:'PERSISTENCE_ERROR'});
  for(const [store,id,hash] of [[memoryStore(),'create',HASH],[fresh(),'bad',HASH],[fresh(),'create','bad'],[memoryStore(cp(p,{create:{status:'submitted',hash:OTHER}})),'create',HASH],[memoryStore(cp(p,{activate:{status:'submitting'}})),'activate',HASH],[memoryStore({...cp(p,{create:{status:'submitting'}}),blob:'x'.repeat(17000)}),'create',HASH]])await assert.rejects(reconcileDeploymentWorkflowStep(p,store,id,hash,f.provider),invalid);
});
test('resuming verified workflows rechecks canonical receipts and current module/governance authorization',async()=>{
  const p=launch(),f=fixture(p);const launchReceipt=f.receipt;
  const record=cp(p,{launch:{status:'verified',hash:HASH},'enable-dao-module':{status:'verified',checkedAt:{blockNumber:100,blockHash:BLOCK}}});
  const store=memoryStore(record);await advanceDeploymentWorkflow(p,store,{vault:{execute:async()=>{throw Error('already enabled');}}},f.provider);assert.equal((await store.load()).steps['allow-multisend'].status,'verified');
  assert.equal((await advanceDeploymentWorkflow(p,store,{},f.provider)).steps.launch.status,'verified');
  f.state.module=false;await assert.rejects(advanceDeploymentWorkflow(p,store,{},f.provider),changed);f.state.module=true;
  await assert.rejects(advanceDeploymentWorkflow(p,store,{}, {...f.provider,getTransactionReceipt:async()=>null}),{code:'TX_PENDING'});
  for(const kind of ['VestingNavigator','BudgetNavigator','SignalNavigator']){
    const n=nav(kind),cf=fixture(n),af=fixture(n,'activate');cf.state.deployed=true;const ar={...af.receipt,hash:OTHER};
    const provider={...cf.provider,getTransactionReceipt:async hash=>hash===HASH?cf.receipt:ar,call:af.provider.call};
    const done=memoryStore(cp(n,{create:{status:'verified',hash:HASH},activate:{status:'verified',hash:OTHER}}));
    if(kind==='SignalNavigator'){await assert.rejects(advanceDeploymentWorkflow(n,done,{},provider),changed);await advanceDeploymentWorkflow(n,done,{},provider,{verifyCurrentSignalEndorsement:async()=>true});}
    else{await advanceDeploymentWorkflow(n,done,{},provider);if(kind==='BudgetNavigator')af.state.module=false;else af.state.permission=0n;await assert.rejects(advanceDeploymentWorkflow(n,done,{},provider));}
  }
});

test('verification captures executor-owned receipt identity before asynchronous provider reads',async()=>{
  const p=nav(),f=fixture(p);f.state.deployed=true;const supplied={...f.receipt};
  await verifyDeploymentWorkflowStep(p,'create',supplied,{...f.provider,getNetwork:async()=>{supplied.hash=OTHER;supplied.blockNumber=999;return {chainId:9n};}});
  const store=memoryStore();f.state.deployed=false;let returned;
  const provider={...f.provider,getNetwork:async()=>{if(returned){returned.hash=OTHER;returned.blockNumber=999;}return {chainId:9n};}};
  await advanceDeploymentWorkflow(p,store,{creation:{execute:async(_p,_s,ctx)=>{await ctx.onSubmitted(HASH);f.state.deployed=true;returned={...f.receipt};return returned;}}},provider);
  assert.equal((await store.load()).steps.create.hash,HASH);
});
test('Signal full-set activation requires caller-authenticated fresh input before the executor can submit',async()=>{
  const p=nav('SignalNavigator'),f=fixture(p),af=fixture(p,'activate');f.state.deployed=true;let sends=0;
  const initial=cp(p,{create:{status:'verified',hash:HASH}}),ar={...af.receipt,hash:OTHER};
  const provider={...f.provider,call:af.provider.call,getTransactionReceipt:async hash=>hash===HASH?f.receipt:ar};
  const executor={execute:async(_p,_s,ctx)=>{sends++;await ctx.onSubmitted(OTHER);return ar;}};
  for(const options of [{},{verifyCurrentSignalEndorsement:async()=>false}])await assert.rejects(advanceDeploymentWorkflow(p,memoryStore(initial),{'dao-governance':executor},provider,options),changed);
  assert.equal(sends,0);
  const stages=[];await advanceDeploymentWorkflow(p,memoryStore(initial),{'dao-governance':executor},provider,{verifyCurrentSignalEndorsement:async(_p,stage)=>{stages.push(stage);return true;}});
  assert.equal(sends,1);assert.deepEqual(stages,['before-activation']);
});
test('explicit repriced reconciliation verifies same nonce, sender, chain and payload before accepting replacement receipt',async()=>{
  const p=nav(),f=fixture(p);f.state.deployed=true;
  const ar={...f.receipt,hash:OTHER},original={...f.tx,nonce:5},candidate={...original,hash:OTHER};
  const provider={...f.provider,getTransactionReceipt:async()=>ar,getTransaction:async hash=>hash===HASH?original:candidate};
  const fresh=()=>memoryStore(cp(p,{create:{status:'submitted',hash:HASH}}));
  assert.equal((await reconcileDeploymentWorkflowStep(p,fresh(),'create',OTHER,provider,{replacementOf:HASH})).steps.create.hash,OTHER);
  for(const patch of [{from:V},{nonce:6},{chainId:8n},{value:1n},{data:'0x'},{to:V},{hash:HASH}])await assert.rejects(reconcileDeploymentWorkflowStep(p,fresh(),'create',OTHER,{...provider,getTransaction:async hash=>hash===HASH?original:{...candidate,...patch}},{replacementOf:HASH}),response);
  await assert.rejects(reconcileDeploymentWorkflowStep(p,fresh(),'create',OTHER,{...provider,getTransaction:async()=>null},{replacementOf:HASH}),response);
  for(const nonce of [undefined,-1,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(reconcileDeploymentWorkflowStep(p,fresh(),'create',OTHER,{...provider,getTransaction:async hash=>({...hash===HASH?original:candidate,nonce})},{replacementOf:HASH}),response);
});

test('workflow provider synchronous blocking cannot bypass a configured deadline', async () => {
  const plan = launch('direct');
  const provider = { getNetwork() {
    const until = performance.now() + 15;
    while (performance.now() < until) {}
    return Promise.resolve({ chainId: BigInt(plan.chainId) });
  } };
  await assert.rejects(prepareDAOShipLaunch(plan, provider, { timeoutMs: 2 }), { code: 'TIMEOUT' });
});

test('workflow confirmation policy applies to verification and recovery without authorizing a resend', async () => {
  const p = launch(), f = fixture(p, 'launch');
  await assert.rejects(verifyDeploymentWorkflowStep(p, 'launch', f.receipt, f.provider, { confirmations: 2 }), { code: 'TX_PENDING' });
  const store = memoryStore(cp(p, { launch: { status: 'submitting' } }));
  await assert.rejects(reconcileDeploymentWorkflowStep(p, store, 'launch', HASH, f.provider, { confirmations: 2 }), { code: 'TX_PENDING' });
  assert.equal((await store.load()).steps.launch.status, 'submitting');
  f.state.latest = 101;
  await verifyDeploymentWorkflowStep(p, 'launch', f.receipt, f.provider, { confirmations: 2 });
  assert.equal((await reconcileDeploymentWorkflowStep(p, store, 'launch', HASH, f.provider, { confirmations: 2 })).steps.launch.status, 'verified');
  for (const confirmations of [0, -1, 1.5, 10001, Infinity]) {
    await assert.rejects(verifyDeploymentWorkflowStep(p, 'launch', f.receipt, f.provider, { confirmations }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(advanceDeploymentWorkflow(p, { load() { throw Error('Must not read state'); } }, {}, f.provider, { confirmations }), { code: 'INVALID_ARGUMENT' });
  }
});

test('native Quai creation plans preserve the grinded suffix and verify the committed nonce', async () => {
  const { grindCreation } = await import('../scripts/orchard/support.mjs');
  const { encodeNavigatorDeployment } = await import('../dist/navigators.js');
  const input = navInput('VestingNavigator', { addressPolicy: 'cyprus1' });
  const grinded = await grindCreation(A, 17, encodeNavigatorDeployment(input.kind, input.bytecode, input.config));
  const plan = buildNavigatorDeploymentPlan({ ...input, expectedAddress: grinded.expectedAddress, quaiCreation: grinded.quaiCreation });
  assert.equal(plan.creationData, grinded.creationData);
  assert.equal(plan.creationData.slice(-8), grinded.quaiCreation.salt.slice(2));
  const f = fixture(plan); f.tx.nonce = 17; f.provider.getTransactionCount = async () => 17;
  f.state.codeOverrides[plan.expectedAddress] = '0x';
  await prepareDeploymentWorkflowStep(plan, 'create', f.provider);
  f.provider.getTransactionCount = async () => 18;
  await assert.rejects(prepareDeploymentWorkflowStep(plan, 'create', f.provider), { code: 'PLAN_CHANGED' });
  delete f.provider.getTransactionCount;
  await assert.rejects(prepareDeploymentWorkflowStep(plan, 'create', f.provider), { code: 'INVALID_ARGUMENT' });
  f.state.codeOverrides[plan.expectedAddress] = '0x6000';
  await verifyDeploymentWorkflowStep(plan, 'create', f.receipt, f.provider);
  f.tx.nonce = 18;
  await assert.rejects(verifyDeploymentWorkflowStep(plan, 'create', f.receipt, f.provider), { code: 'INVALID_RESPONSE' });
  for (const patch of [{ quaiCreation: { nonce: -1, salt: '0x00000000' } }, { quaiCreation: { nonce: 17, salt: '0x00' } }, { addressPolicy: 'evm' }, { expectedAddress: N }]) {
    assert.throws(() => buildNavigatorDeploymentPlan({ ...input, expectedAddress: plan.expectedAddress, quaiCreation: plan.quaiCreation, ...patch }), { code: 'INVALID_ARGUMENT' });
  }
});
