import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { checkRelease } from './check-release.mjs';
import { saveReleaseArchive } from './pack-release.mjs';

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}
const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryInstall = process.argv.includes('--registry-install');
const release = process.argv.includes('--save-release') ? await checkRelease() : null;
const temporary = await mkdtemp(join(tmpdir(), 'daoships-package-'));
const options = { cwd: temporary, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, npm_config_cache: join(temporary, 'npm-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false' } };
const inside = (parent, file) => { const path = relative(parent, file); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };

try {
  // Build belongs to the caller's test:package command. Pack the actual allowlist,
  // without lifecycle hooks or registry access, then run outside the SDK checkout.
  const packed = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { ...options, cwd: sdk })).stdout);
  assert.equal(packed.length, 1);
  const files = new Set(packed[0].files.map(file => file.path));
  const sourceNames = new Set((await readdir(join(sdk, 'src'))).filter(file => file.endsWith('.ts')).map(file => file.slice(0, -3)));
  assert.ok(files.has('dist/index.js') && files.has('dist/index.d.ts'));
  for (const file of files) {
    assert.ok(!file.startsWith('src/') && !file.startsWith('scripts/') && !file.startsWith('test/') && !file.startsWith('examples/') && !file.includes('node_modules/'), `Unexpected development file in package: ${file}`);
    if (file.startsWith('dist/')) {
      const emitted = /^dist\/([^/]+?)(?:\.d\.ts|\.js(?:\.map)?)$/.exec(file);
      assert.ok(emitted && sourceNames.has(emitted[1]), `Stale or unexpected compiler output in package: ${file}`);
    }
  }
  await run('tar', ['-xzf', join(temporary, packed[0].filename), '-C', temporary], options);
  const contents = join(temporary, 'package');
  const manifest = JSON.parse(await readFile(join(contents, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './abis', './bytecode', './contracts', './indexer']);
  assert.deepEqual(Object.keys(manifest.dependencies), ['quais']);
  let moduleCount = 0, linkCount = 0;
  for (const file of files) {
    if (/\.m?js$|\.d\.ts$/.test(file)) {
      moduleCount++;
      const source = ts.createSourceFile(file, await readFile(join(contents, file), 'utf8'), ts.ScriptTarget.Latest, true);
      const verify = specifier => {
        if (specifier === 'quais') return;
        assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${file}: undeclared runtime/type dependency ${specifier}`);
        const target = resolve(contents, dirname(file), specifier);
        assert.ok(inside(contents, target), `${file}: import escapes package: ${specifier}`);
        const path = relative(contents, target).replaceAll('\\', '/');
        assert.ok(files.has(path) || (file.endsWith('.d.ts') && files.has(path.replace(/\.js$/, '.d.ts'))), `${file}: missing import target ${specifier}`);
      };
      const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) verify(node.moduleSpecifier.text);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) verify(node.argument.literal.text);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          assert.equal(node.arguments.length, 1, `${file}: unsupported dynamic import`);
          assert.ok(ts.isStringLiteral(node.arguments[0]), `${file}: computed imports require an explicit package audit`);
          verify(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (file.endsWith('.md')) {
      const source = await readFile(join(contents, file), 'utf8');
      // Validate inline Markdown links and reference-style link definitions.
      const targets = [...source.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)].map(match => match[1]);
      targets.push(...[...source.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map(match => match[1]));
      for (const target of targets) {
        if (/^https?:\/\/|^mailto:|^#/.test(target)) continue;
        assert.ok(!/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('/'), `${file}: nonportable documentation link ${target}`);
        const destination = decodeURIComponent(target.split(/[?#]/)[0]);
        const local = resolve(contents, dirname(file), destination);
        assert.ok(inside(contents, local), `${file}: documentation escapes package: ${target}`);
        const path = relative(contents, local).replaceAll('\\', '/');
        assert.ok(files.has(path) || [...files].some(entry => entry.startsWith(`${path}/`)), `${file}: documentation target is not packaged: ${target}`);
        linkCount++;
      }
    }
  }
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  if (registryInstall) {
    // Explicit opt-in: install the actual tarball and fetch its dependency graph
    // into a fresh cache. Never execute dependency lifecycle scripts.
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(temporary, packed[0].filename)], {
      ...options, cwd: consumer, env: { ...options.env, npm_config_offline: 'false' },
    });
  } else {
    await mkdir(join(consumer, 'node_modules', '@daoships'), { recursive: true });
    await symlink(contents, join(consumer, 'node_modules', '@daoships', 'sdk'), 'dir');
    const dependency = await realpath(join(sdk, 'node_modules', 'quais'));
    // The package's own resolver starts from temporary/package, hence this link.
    await mkdir(join(temporary, 'node_modules'), { recursive: true });
    await symlink(dependency, join(temporary, 'node_modules', 'quais'), 'dir');
  }
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import * as sdk from '@daoships/sdk';
import { CONTRACT_ABIS } from '@daoships/sdk/abis';
import { ContractClient } from '@daoships/sdk/contracts';
import { DaoShipsIndexer, indexerShapes } from '@daoships/sdk/indexer';
import { NAVIGATOR_BYTECODES } from '@daoships/sdk/bytecode';
assert.equal(Object.keys(CONTRACT_ABIS).length, 17);
assert.equal(Object.keys(indexerShapes).length, 25);
assert.equal(Object.keys(NAVIGATOR_BYTECODES).length, 8);
const target = '0x0011111111111111111111111111111111111111';
const call = new ContractClient('SharesERC20', target).encode('approve', [target, 9007199254740993n]);
assert.equal(call.to.toLowerCase(), target);
assert.match(call.data, /^0x095ea7b3/);
assert.equal(sdk.parseTokenAmount('1.000000000000000001', 18), 1000000000000000001n);
assert.equal(sdk.decodeProposal(sdk.encodeProposal([call]))[0].value, 0n);
assert.equal(sdk.getNavigatorRequirements('BudgetNavigator').vaultModule, true);
assert.equal(typeof sdk.resolveVaultModulePredecessor, 'function');
const connection = await sdk.connectDaoShipsSupabase({ network: 'mainnet', fetch: async (_url, request) => {
  assert.equal(request.headers.apikey, sdk.DAOSHIPS_SUPABASE.publishableKey);
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers['Accept-Profile'], 'mainnet');
  return Response.json([{ id: 1, chain_id: 9, last_block_number: '123', last_block_hash: null,
    last_indexed_at: new Date().toISOString(), is_syncing: false, requires_full_reindex: false,
    reindex_reason: null, reindex_flagged_at: null }]);
} });
assert.equal(connection.chainId, 9);
assert.equal(connection.health.indexedBlock, 123n);
assert.ok(connection.data instanceof sdk.DaoShipsData);
for (const name of ['buildDAOShipLaunchPlan', 'buildNavigatorDeploymentPlan', 'prepareDeploymentWorkflowStep',
  'advanceDeploymentWorkflow', 'reconcileDeploymentWorkflowStep', 'sendRecoverableTransaction', 'inspectRecoveryTransaction', 'scanRecoveryReplacements',
  'fetchIpfsAllowlist', 'publishAllowlist', 'watchIndexer', 'supabaseRealtimeAdapter', 'DaoShipsData']) assert.equal(typeof sdk[name], 'function');
assert.equal(sdk.buildTokenApprovalPlan({ token: target, owner: target, spender: target, currentAllowance: 0n, requiredAllowance: 1n }).steps.length, 1);
const store = new sdk.InMemoryTransactionRecoveryStore();
const nonce = { version: 1, kind: 'nonce', id: 'account', revision: 0, chainId: 15000, from: target, nextNonce: 2, blockedBy: null };
assert.equal(await store.compareAndSwap('account', null, nonce), true);
assert.deepEqual(sdk.parseRecoveryRecord(sdk.serializeRecoveryRecord(nonce)), nonce);
assert.deepEqual(sdk.buildDaoProfileUpdate(target, { name: 'Before', banner: 'https://example.invalid/banner' }, { name: 'After' }),
  { daoAddress: target, name: 'After', banner: 'https://example.invalid/banner' });
const indexer = new DaoShipsIndexer({ url: 'https://example.invalid', key: 'sb_publishable_fixture', schema: 'testnet', fetch: async (_url, request) => request.method === 'HEAD' ? new Response(null, { headers: { 'content-range': '*/9007199254740993' } }) : Response.json([]) });
assert.deepEqual((await indexer.list('daos')).items, []);
assert.equal(await indexer.count('daos'), 9007199254740993n);
console.log('Packed ESM consumer imported all five subpaths and executed contract, value and indexer calls.');
`);
  await writeFile(join(consumer, 'consumer.ts'), `
import { parseTokenAmount, decodeProposal, buildDaoProfileUpdate, getNavigatorRequirements, resolveVaultModulePredecessor, type Hex } from '@daoships/sdk';
import { CONTRACT_ABIS, type ContractName } from '@daoships/sdk/abis';
import { ContractClient, type ContractMethods } from '@daoships/sdk/contracts';
import { DaoShipsIndexer, type IndexerTables, type IndexerIterationOptions } from '@daoships/sdk/indexer';
import { NAVIGATOR_BYTECODES } from '@daoships/sdk/bytecode';
import { connectDaoShipsSupabase, type DaoShipsSupabaseOptions } from '@daoships/sdk';
const hosted: DaoShipsSupabaseOptions = { network: 'mainnet', health: { expectedBlock: 123n } };
// @ts-expect-error Hosted connections require an explicit network.
connectDaoShipsSupabase({});
void hosted;
const target: Hex = '0x0011111111111111111111111111111111111111';
const name: ContractName = 'SharesERC20';
const client = new ContractClient(name, target);
const args: ContractMethods['SharesERC20']['approve']['args'] = [target, 1n];
client.encode('approve', args);
// @ts-expect-error ABI integers must remain bigint.
client.encode('approve', [target, 1]);
// @ts-expect-error Unknown methods must not be accepted.
client.encode('definitelyMissing', []);
const options: IndexerIterationOptions<'records'> = { maxPages: 2, where: [{ column: 'block_number', operator: 'gte', value: 1n }] };
declare const indexer: DaoShipsIndexer;
const rows: Promise<IndexerTables['records'][]> = indexer.list('records', options).then(page => page.items);
// @ts-expect-error Tables outside the public schema cannot be queried.
indexer.list('processed_logs');
const value: bigint = parseTokenAmount('1', 18);
const creation: Hex = NAVIGATOR_BYTECODES.BudgetNavigator;
const count: Promise<bigint> = indexer.count('daos', { where: [{ column: 'name', operator: 'ilike', value: '%dao%' }] });
const update = buildDaoProfileUpdate(target, { banner: 'https://example.invalid/banner' }, { name: null });
const decoded = decodeProposal('0x');
const requirement: 0n | 2n | 4n = getNavigatorRequirements('TimelockNavigator').daoPermission;
void [count, update, decoded, requirement, resolveVaultModulePredecessor];
void [CONTRACT_ABIS, rows, value, creation];
`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: [], lib: ['ES2022', 'DOM'] }, files: ['consumer.ts'] }));
  // Restrict runtime filesystem reads to the extracted package/consumer and the
  // installed dependency tree. Original SDK source/dist and sibling projects are
  // inaccessible even if a future implementation tries an indirect filesystem read.
  const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  const allowedReads = [`--allow-fs-read=${temporary}`, ...(registryInstall ? [] : [`--allow-fs-read=${await realpath(join(sdk, 'node_modules'))}`])];
  const esm = await run(process.execPath, [permissionFlag, ...allowedReads, join(consumer, 'consumer.mjs')], { ...options, cwd: consumer });
  process.stdout.write(esm.stdout);
  await run(process.execPath, [join(sdk, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(consumer, 'tsconfig.json')], { ...options, cwd: consumer });
  console.log(`Packed TypeScript consumer passed strict declaration checks and negative type assertions; ${moduleCount} emitted modules/declarations and ${linkCount} relative documentation links validated.`);
  console.log(registryInstall
    ? 'Fresh registry install passed: actual SDK tarball and newly downloaded dependencies; lifecycle scripts disabled; runtime filesystem access restricted to temporary consumer. No live-chain acceptance claim.'
    : 'Offline isolation method: actual npm tarball extracted outside the workspace; only installed quais linked, with its existing transitive dependencies; Node filesystem permissions exclude original SDK source/dist and sibling projects. No clean-registry-install or live-network claim.');
  if (release) console.log(JSON.stringify(await saveReleaseArchive(join(temporary, packed[0].filename), packed[0], release.version)));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
