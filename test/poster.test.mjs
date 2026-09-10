import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id, Interface } from 'quais';
import { POSTER_TAGS, buildPosterContent, encodePosterPost, validatePosterContent, posterTagTopic } from '../dist/poster.js';
import { buildAllowlistTree } from '../dist/allowlist.js';
import { CONTRACT_ABIS } from '../dist/abis.js';
const A = '0x0011111111111111111111111111111111111111', B = '0x0022222222222222222222222222222222222222';
const treeDump = buildAllowlistTree([A,B]);
const samples = {
  [POSTER_TAGS.DAO_PROFILE_INITIAL]: {daoAddress:A,name:'DAO Ships',description:'Builders',theme:{mode:'dark',primary:'#abc'}},
  [POSTER_TAGS.DAO_PROFILE]: {daoAddress:A,description:'A new description'},
  [POSTER_TAGS.DAO_ANNOUNCEMENT]: {daoAddress:A,title:'Update',severity:'info',expiresAt:'2030-01-01T00:00:00Z'},
  [POSTER_TAGS.MEMBER_PROFILE]: {daoAddress:A,name:'Member',bio:'Builder'},
  [POSTER_TAGS.PROPOSAL_VOTE_REASON]: {daoAddress:A,proposalId:1,vote:true,reason:'Approved'},
  [POSTER_TAGS.NAVIGATOR_ALLOWLIST]: {daoAddress:A,navigatorAddress:B,root:treeDump.tree[0],addresses:[A,B],treeDump},
  [POSTER_TAGS.DAO_NAVIGATORS]: {daoAddress:A,navigators:[]},
  [POSTER_TAGS.SIGNAL_POLL]: {daoAddress:A,navigatorAddress:B,pollId:2n**100n,options:['Yes','No']},
};
test('all eight recognized tags produce versioned, ABI-encoded JSON metadata', () => {
  const iface = new Interface(CONTRACT_ABIS.Poster);
  for (const [tag,payload] of Object.entries(samples)) {
    const content=buildPosterContent(tag,payload);assert.equal(JSON.parse(content).schemaVersion,'1.0');
    assert.equal(validatePosterContent(tag,JSON.parse(content)).valid,true);
    const tx=encodePosterPost(A,tag,payload);const args=iface.decodeFunctionData('post(string,string)',tx.data);
    assert.equal(args[0],content);assert.equal(args[1],tag);assert.equal(tx.value,0n);assert.equal(tx.to,A);
    assert.equal(posterTagTopic(tag),id(tag));
  }
});
test('poll identifiers remain exact above Number.MAX_SAFE_INTEGER and option count cross-check rejects mismatches', () => {
  const payload=samples[POSTER_TAGS.SIGNAL_POLL];
  assert.equal(JSON.parse(buildPosterContent(POSTER_TAGS.SIGNAL_POLL,payload)).pollId,(2n**100n).toString());
  assert.throws(()=>buildPosterContent(POSTER_TAGS.SIGNAL_POLL,payload,{signalOptionCount:3}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>buildPosterContent(POSTER_TAGS.SIGNAL_POLL,{...payload,pollId:Number.MAX_SAFE_INTEGER+1}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>buildPosterContent(POSTER_TAGS.SIGNAL_POLL,{...payload,options:['Yes','']}),{code:'INVALID_ARGUMENT'});
});
test('profile schema matches indexer limits and rejects silently dropped nulls and unsafe theme/url values', () => {
  const tag=POSTER_TAGS.DAO_PROFILE;
  assert.doesNotThrow(()=>buildPosterContent(tag,{daoAddress:A,name:'x'.repeat(100),description:'x'.repeat(1000)}));
  for (const patch of [{name:'x'.repeat(101)},{banner:null},{theme:{primary:'#fff; color:red'}},{avatar:'javascript:alert(1)'},{links:{bad:'javascript:foo'}},{tags:['x'.repeat(51)]},{arbitrary:'ignored'}]) assert.throws(()=>buildPosterContent(tag,{daoAddress:A,...patch}),{code:'INVALID_ARGUMENT'});
});
test('Poster strips disallowed controls, enforces UTF-8 byte size, and rejects nonobjects and unknown tags', () => {
  assert.equal(JSON.parse(buildPosterContent(POSTER_TAGS.MEMBER_PROFILE,{daoAddress:A,name:'A\x00\x80B',bio:'line\n2'})).name,'AB');
  assert.throws(()=>buildPosterContent(POSTER_TAGS.DAO_ANNOUNCEMENT,{daoAddress:A,title:'t',body:'\u0800'.repeat(4096),url:'https://x/'+ '\u0800'.repeat(1900)}),{code:'INVALID_ARGUMENT'});
  assert.equal(validatePosterContent('other',{}).valid,false);
  assert.equal(validatePosterContent(POSTER_TAGS.DAO_PROFILE,[]).valid,false);
  assert.equal(validatePosterContent('__proto__',{}).valid,false);
});
test('inline allowlist metadata binds root, address set and dump; CID format is exclusive', () => {
  const tag=POSTER_TAGS.NAVIGATOR_ALLOWLIST,payload=samples[tag];
  assert.throws(()=>buildPosterContent(tag,{...payload,root:'0x'+'11'.repeat(32)}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>buildPosterContent(tag,{...payload,addresses:[A,A]}),{code:'INVALID_ARGUMENT'});
  const cid='Qm'+'a'.repeat(44);
  assert.throws(()=>buildPosterContent(tag,{...payload,ipfsCid:cid}),{code:'INVALID_ARGUMENT'});
  assert.doesNotThrow(()=>buildPosterContent(tag,{daoAddress:A,navigatorAddress:B,root:treeDump.tree[0],ipfsCid:cid}));
});
