import { Shard, Interface, ContractFactory, keccak256, toUtf8Bytes, toBeHex, type Provider } from 'quais';
import { DaoShipsError } from './errors.js';
import { address, hex, uint, stringify, type Hex } from './values.js';
import { ContractClient, type EncodedCall, type ContractReadOptions } from './contracts.js';
import type { PreparedTransaction } from './chain.js';
import type { DeploymentContracts, DeploymentReadOptions } from './deployments.js';
import { decodeLaunchInitParams, encodeLaunchInitParams, encodeLaunchDAOShip, encodeLaunchDAOShipWithVault, encodeLaunchDAOShipAndVault, type LaunchParams } from './launch.js';
import { predictDAOShipAddresses, predictLaunchAddress, vaultInitCodeHash, isCyprus1Address } from './launch-create2.js';
import { buildGovernanceAction } from './governance.js';
import { encodeProposal, hashProposalData, type ProposalAction } from './encoding.js';
import { encodeNavigatorDeployment, navigatorDeploymentArgs, parseNavigatorDeploymentReceipt, type NavigatorKind, type NavigatorDeployConfig } from './navigators.js';
import { CONTRACT_ABIS } from './abis.js';
import { getNavigatorRequirements } from './navigator-permissions.js';
import { encodePosterPost, POSTER_TAGS, posterTagTopic } from './poster.js';
import { parseContractEvents } from './events.js';
import { assertActionSucceeded, type Receipt } from './receipts.js';

export type DeploymentAddressPolicy = 'cyprus1' | 'evm';
export interface DeploymentWorkflowStep {
  readonly id: string;
  readonly kind: 'transaction' | 'creation' | 'dao-governance' | 'vault';
  readonly dependsOn: readonly string[];
  readonly calls: readonly EncodedCall[];
  readonly creationData?: Hex;
  readonly proposalData?: Hex;
}
interface WorkflowBase {
  readonly version: 1;
  readonly id: Hex;
  readonly chainId: number;
  readonly from: Hex;
  readonly addressPolicy: DeploymentAddressPolicy;
  readonly steps: readonly DeploymentWorkflowStep[];
}
export type DAOShipLaunchInput = {
  chainId: number; from: string; deployment: DeploymentContracts; parameters: LaunchParams;
  /** Default requires Cyprus-1 addresses. `evm` is explicit for an EVM-compatible test chain. */
  addressPolicy?: DeploymentAddressPolicy;
} & (
  | { route: 'direct' | 'existing-vault'; existingVault: string }
  | { route: 'new-vault'; vaultOwners: readonly string[]; vaultThreshold: bigint; vaultSalt: bigint; vaultProxyBytecode: string }
);
export interface DAOShipLaunchPlan extends WorkflowBase {
  readonly type: 'dao-launch';
  readonly route: DAOShipLaunchInput['route'];
  readonly deployment: Readonly<DeploymentContracts>;
  readonly parameters: LaunchParams;
  readonly expected: { readonly daoShip: Hex; readonly shares: Hex; readonly loot: Hex; readonly vault: Hex };
  readonly call: EncodedCall;
  readonly newVault?: { readonly owners: readonly Hex[]; readonly threshold: bigint; readonly salt: bigint; readonly proxyBytecode: Hex };
}
export interface NavigatorWorkflowInput<K extends NavigatorKind> {
  chainId: number; from: string; kind: K; config: NavigatorDeployConfig[K]; bytecode: string;
  /** Final CREATE address supplied by the caller's nonce/grinding preparation. */
  expectedAddress: string; vault: string; addressPolicy?: DeploymentAddressPolicy;
  /** Explicit pinned-quais native CREATE nonce and four-byte suffix from address grinding. */
  quaiCreation?: { nonce: number; salt: string };
  /** Signal endorsement replaces a complete set. Caller must supply its freshly read full set. */
  signalEndorsement?: { poster: string; currentNavigators: readonly { address: string; type?: string }[] };
  /** Optional treasury funding from `from`; amount is explicit raw units, zero address means QUAI. */
  treasuryFunding?: { token: string; amount: bigint };
}
export interface NavigatorDeploymentPlan extends WorkflowBase {
  readonly type: 'navigator'; readonly kind: NavigatorKind; readonly daoShip: Hex; readonly vault: Hex;
  readonly expectedAddress: Hex; readonly creationData: Hex;
  readonly quaiCreation?: { readonly nonce: number; readonly salt: Hex };
  readonly bytecode: Hex; readonly config: NavigatorDeployConfig[NavigatorKind];
  readonly metadata: { readonly name: string; readonly description: string };
  readonly signalEndorsement?: { readonly poster: Hex; readonly content: string; readonly currentNavigators: readonly { address: string; type?: string }[] };
  readonly treasuryFunding?: { readonly token: Hex; readonly amount: bigint };
}
export type DeploymentWorkflowPlan = DAOShipLaunchPlan | NavigatorDeploymentPlan;
const ZERO = '0x0000000000000000000000000000000000000000';
function fail(message: string, code: 'INVALID_ARGUMENT' | 'INVALID_RESPONSE' | 'PLAN_CHANGED' = 'INVALID_ARGUMENT'): never { throw new DaoShipsError(code, message); }
function identity(value: string, policy: DeploymentAddressPolicy): Hex {
  const a = address(value);
  if (BigInt(a) <= 1n || (policy === 'cyprus1' && !isCyprus1Address(a))) fail('Expected a nonzero contract/account address matching the selected address policy.');
  return a;
}
function common(chainId: number, from: string, policy: DeploymentAddressPolicy = 'cyprus1') {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !['cyprus1', 'evm'].includes(policy)) fail('Invalid workflow chain or address policy.');
  return { version: 1 as const, chainId, from: identity(from, policy), addressPolicy: policy };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function finish<T extends Omit<WorkflowBase, 'id'>>(value: T): T & { id: Hex } {
  const content = stringify(value);
  if (content.length > 4_194_304) fail('Deployment plan exceeds the 4 MiB character limit.');
  return freeze({ ...value, id: keccak256(toUtf8Bytes(content)) as Hex });
}
function actionCall(action: ProposalAction, operation: string): EncodedCall { return { to: address(action.to), data: hex(action.data), value: uint(action.value), operation }; }

/** Deterministic immutable plan. Existing-vault setup is explicit and must use authorized vault execution. */
export function buildDAOShipLaunchPlan(input: DAOShipLaunchInput): DAOShipLaunchPlan {
  const base = common(input.chainId, input.from, input.addressPolicy);
  if (!['direct', 'existing-vault', 'new-vault'].includes(input.route)) fail('Unknown launch route.');
  const deployment = Object.fromEntries(['daoShipAndVaultLauncher', 'daoShipLauncher', 'quaiVaultFactory', 'multisendCallOnly', 'daoShipSingleton', 'sharesSingleton', 'lootSingleton', 'vaultSingleton']
    .map(key => [key, identity(input.deployment[key as keyof DeploymentContracts], base.addressPolicy)])) as unknown as DeploymentContracts;
  const decoded = decodeLaunchInitParams(encodeLaunchInitParams(input.parameters.initialization));
  const { lootToken: _loot, sharesToken: _shares, avatar: _avatar, ...initialization } = decoded;
  if (address(initialization.multisendLibrary) !== deployment.multisendCallOnly) fail('Initialization MultiSend must match the selected deployment.');
  const p: LaunchParams = { initialization, shareTokenName: input.parameters.shareTokenName, shareTokenSymbol: input.parameters.shareTokenSymbol,
    lootTokenName: input.parameters.lootTokenName, lootTokenSymbol: input.parameters.lootTokenSymbol,
    sharesSalt: uint(input.parameters.sharesSalt), lootSalt: uint(input.parameters.lootSalt), daoShipSalt: uint(input.parameters.daoShipSalt) };
  const factorySender = input.route === 'direct' ? base.from : deployment.daoShipAndVaultLauncher;
  const predicted = predictDAOShipAddresses({ factory: deployment.daoShipLauncher, sender: factorySender,
    singletons: { daoShip: deployment.daoShipSingleton, shares: deployment.sharesSingleton, loot: deployment.lootSingleton }, ...p });
  Object.values(predicted).forEach(a => identity(a, base.addressPolicy));
  if (new Set(Object.values(predicted).map(a => a.toLowerCase())).size !== 3) fail('Launch salts/singletons predict colliding contracts.');
  let vault: Hex, call: EncodedCall, newVault: DAOShipLaunchPlan['newVault'];
  if (input.route === 'new-vault') {
    if (!Array.isArray(input.vaultOwners) || !input.vaultOwners.length || input.vaultOwners.length > 20) fail('QuaiVault requires 1 to 20 owners.');
    const owners = input.vaultOwners.map(a => identity(a, base.addressPolicy));
    newVault = { owners, threshold: uint(input.vaultThreshold), salt: uint(input.vaultSalt), proxyBytecode: hex(input.vaultProxyBytecode) };
    const data = encodeLaunchDAOShipAndVault({ ...p, vaultOwners: owners, vaultThreshold: newVault.threshold, vaultSalt: newVault.salt });
    vault = identity(predictLaunchAddress(deployment.quaiVaultFactory, deployment.daoShipAndVaultLauncher, newVault.salt,
      vaultInitCodeHash({ proxyBytecode: newVault.proxyBytecode, implementation: deployment.vaultSingleton, owners, threshold: newVault.threshold,
        daoShip: predicted.daoShip, multisendCallOnly: deployment.multisendCallOnly })), base.addressPolicy);
    call = { to: deployment.daoShipAndVaultLauncher, data, value: 0n, operation: 'launchDAOShipAndVault' };
  } else {
    vault = identity(input.existingVault, base.addressPolicy);
    call = { to: input.route === 'direct' ? deployment.daoShipLauncher : deployment.daoShipAndVaultLauncher,
      data: input.route === 'direct' ? encodeLaunchDAOShip({ ...p, existingVault: vault }) : encodeLaunchDAOShipWithVault({ ...p, existingVault: vault }), value: 0n,
      operation: input.route === 'direct' ? 'launchDAOShip' : 'launchDAOShipWithVault' };
  }
  if (Object.values(predicted).some(a => a === vault)) fail('Vault and DAO/token predictions must be distinct.');
  const steps: DeploymentWorkflowStep[] = [{ id: 'launch', kind: 'transaction', dependsOn: [], calls: [call] }];
  if (!newVault) {
    const client = new ContractClient('QuaiVault', vault);
    steps.push({ id: 'enable-dao-module', kind: 'vault', dependsOn: ['launch'], calls: [client.encode('enableModule', [predicted.daoShip])] });
    steps.push({ id: 'allow-multisend', kind: 'vault', dependsOn: ['enable-dao-module'], calls: [client.encode('addDelegatecallTarget', [deployment.multisendCallOnly])] });
  }
  return finish({ ...base, type: 'dao-launch' as const, route: input.route, deployment, parameters: p, expected: { ...predicted, vault }, call, steps,
    ...(newVault ? { newVault } : {}) });
}

/** CREATE is performed by a caller-supplied Quai-aware executor; activation is a separate explicit step. */
export function buildNavigatorDeploymentPlan<K extends NavigatorKind>(input: NavigatorWorkflowInput<K>): NavigatorDeploymentPlan {
  const base = common(input.chainId, input.from, input.addressPolicy), requirements = getNavigatorRequirements(input.kind);
  const daoShip = identity(input.config.daoShip, base.addressPolicy), vault = identity(input.vault, base.addressPolicy), target = identity(input.expectedAddress, base.addressPolicy);
  if (typeof input.bytecode !== 'string' || input.bytecode.length > 2_097_154) fail('Navigator creation bytecode exceeds 1 MiB.');
  const args = navigatorDeploymentArgs(input.kind, input.config), ctor = new Interface(CONTRACT_ABIS[input.kind]).deploy.inputs;
  const config = Object.fromEntries(ctor.map((field, i) => [field.name.replace(/^_/, ''), args[i]])) as unknown as NavigatorDeployConfig[K];
  let creationData = encodeNavigatorDeployment(input.kind, input.bytecode, input.config);
  let quaiCreation: NavigatorDeploymentPlan['quaiCreation'];
  if (input.quaiCreation !== undefined) {
    const { nonce } = input.quaiCreation, salt = hex(input.quaiCreation.salt);
    if (base.addressPolicy !== 'cyprus1' || !Number.isSafeInteger(nonce) || nonce < 0 || salt.length !== 10) fail('Quai creation requires a safe nonce and four-byte grinding suffix on Cyprus-1.');
    quaiCreation = { nonce, salt };
    creationData = hex(creationData + salt.slice(2));
    if (address(ContractFactory.getContractAddress({ from: base.from, nonce: BigInt(nonce), data: creationData })) !== target) fail('Quai CREATE address does not match its nonce and grinded constructor bytes.');
  }
  const steps: DeploymentWorkflowStep[] = [{ id: 'create', kind: 'creation', dependsOn: [], calls: [], creationData }];
  let signalEndorsement: NavigatorDeploymentPlan['signalEndorsement'];
  if (requirements.daoPermission) {
    const call = actionCall(buildGovernanceAction(daoShip, { method: 'setNavigators', navigators: [target], permissions: [requirements.daoPermission] }), 'setNavigators');
    steps.push({ id: 'activate', kind: 'dao-governance', dependsOn: ['create'], calls: [call], proposalData: encodeProposal([call]) });
  } else if (requirements.vaultModule) {
    // DAOShip executes the proposal through MultiSend in the vault's context.
    // The inner CALL to the vault therefore satisfies enableModule's onlySelf gate.
    const call = new ContractClient('QuaiVault', vault).encode('enableModule', [target]);
    steps.push({ id: 'activate', kind: 'dao-governance', dependsOn: ['create'], calls: [call], proposalData: encodeProposal([call]) });
  } else {
    if (!input.signalEndorsement || !Array.isArray(input.signalEndorsement.currentNavigators)) fail('Signal activation requires the full current endorsed navigator set and Poster address.');
    const poster = identity(input.signalEndorsement.poster, base.addressPolicy);
    const list = input.signalEndorsement.currentNavigators.map(n => ({ address: identity(n.address, base.addressPolicy), ...(n.type === undefined ? {} : { type: n.type }) }));
    if (list.some(n => n.address === target)) fail('Signal navigator already occurs in the supplied endorsed set.');
    const call = encodePosterPost(poster, POSTER_TAGS.DAO_NAVIGATORS, { daoAddress: daoShip, navigators: [...list, { address: target, type: input.kind }] });
    const content = new Interface(['function post(string,string)']).decodeFunctionData('post', call.data)[0] as string;
    signalEndorsement = { poster, content, currentNavigators: list };
    steps.push({ id: 'activate', kind: 'dao-governance', dependsOn: ['create'], calls: [call], proposalData: encodeProposal([call]) });
  }
  let treasuryFunding: NavigatorDeploymentPlan['treasuryFunding'];
  if (input.treasuryFunding) {
    const token = address(input.treasuryFunding.token), amount = uint(input.treasuryFunding.amount);
    if (!amount) fail('Treasury funding must be positive.');
    if (token !== ZERO) identity(token, base.addressPolicy);
    treasuryFunding = { token, amount };
    const call = token === ZERO ? { to: vault, value: amount, data: '0x' as Hex, operation: 'fundTreasury' }
      : new ContractClient('SharesERC20', token).encode('transfer', [vault, amount]);
    steps.push({ id: 'fund-treasury', kind: 'transaction', dependsOn: ['activate'], calls: [call] });
  }
  return finish({ ...base, type: 'navigator' as const, kind: input.kind, daoShip, vault, expectedAddress: target, creationData, bytecode: hex(input.bytecode), config,
    metadata: { name: config.name, description: config.description }, steps,
    ...(quaiCreation ? { quaiCreation } : {}), ...(signalEndorsement ? { signalEndorsement } : {}), ...(treasuryFunding ? { treasuryFunding } : {}) });
}

/** Reconstruct the authorized domain plan rather than trusting caller-supplied calls or IDs. */
function capturePlan<T extends DeploymentWorkflowPlan>(input: T): T {
  let plan: T;
  try { plan = structuredClone(input); } catch { return fail('Deployment plan must be cloneable data.'); }
  let rebuilt: DeploymentWorkflowPlan;
  if (plan?.type === 'dao-launch') {
    const base = { chainId: plan.chainId, from: plan.from, addressPolicy: plan.addressPolicy, deployment: plan.deployment, parameters: plan.parameters };
    if (plan.route === 'new-vault') {
      if (!plan.newVault) fail('New-vault plan is missing its constructor configuration.');
      rebuilt = buildDAOShipLaunchPlan({ ...base, route: 'new-vault', vaultOwners: plan.newVault.owners, vaultThreshold: plan.newVault.threshold, vaultSalt: plan.newVault.salt, vaultProxyBytecode: plan.newVault.proxyBytecode });
    } else rebuilt = buildDAOShipLaunchPlan({ ...base, route: plan.route, existingVault: plan.expected.vault });
  } else if (plan?.type === 'navigator') {
    rebuilt = buildNavigatorDeploymentPlan({ chainId: plan.chainId, from: plan.from, addressPolicy: plan.addressPolicy, kind: plan.kind, config: plan.config, bytecode: plan.bytecode,
      expectedAddress: plan.expectedAddress, vault: plan.vault, ...(plan.quaiCreation ? { quaiCreation: plan.quaiCreation } : {}), ...(plan.signalEndorsement ? { signalEndorsement: plan.signalEndorsement } : {}), ...(plan.treasuryFunding ? { treasuryFunding: plan.treasuryFunding } : {}) });
  } else return fail('Unknown deployment workflow type.');
  if (plan.id !== rebuilt.id || stringify(plan) !== stringify(rebuilt)) fail('Deployment plan was modified or has inconsistent derived fields.', 'PLAN_CHANGED');
  return rebuilt as T;
}

export type DeploymentWorkflowProvider = Pick<Provider, 'getNetwork' | 'getBlock' | 'getCode' | 'call' | 'getTransaction' | 'getTransactionReceipt'> & Partial<Pick<Provider, 'getTransactionCount'>>;
type PlanProvider = Pick<DeploymentWorkflowProvider, 'getNetwork' | 'getBlock' | 'getCode' | 'call' | 'getTransactionCount'>;
function operations(provider: PlanProvider, chainId: number, options: DeploymentReadOptions = {}) {
  const settings = { ...options }, timeoutMs = settings.timeoutMs ?? 30_000;
  const maxBytes = settings.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) fail('Invalid deployment read limits.');
  const rpc = <T>(operation: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    let done = false;
    const finish = (error?: unknown, value?: T) => { if (done) return; done = true; clearTimeout(timer); settings.signal?.removeEventListener('abort', abort);
      if (!error && performance.now() >= deadline) error = new DaoShipsError('TIMEOUT', 'Deployment workflow provider timed out.');
      error ? reject(error) : resolve(value!); };
    const abort = () => finish(new DaoShipsError('ABORTED', 'Deployment workflow read cancelled.'));
    const timer = setTimeout(() => finish(new DaoShipsError('TIMEOUT', 'Deployment workflow provider timed out.')), timeoutMs);
    if (settings.signal?.aborted) { abort(); return; }
    settings.signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => done ? undefined : operation()).then(value => finish(undefined, value), error => finish(error instanceof DaoShipsError ? error : new DaoShipsError('CHAIN_ERROR', 'Deployment provider operation failed.', {}, { cause: error })));
  });
  const network = async () => { if ((await rpc(() => provider.getNetwork())).chainId !== BigInt(chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'Workflow provider chain differs from the plan.'); };
  const snapshot = async () => { await network(); const block = await rpc(() => provider.getBlock(Shard.Cyprus1, 'latest'));
    if (!block?.hash || !/^0x[\da-fA-F]{64}$/.test(block.hash) || !Number.isSafeInteger(block.woHeader?.number) || block.woHeader.number < 0) fail('Expected a mined workflow block.', 'INVALID_RESPONSE');
    return { blockNumber: block.woHeader.number, blockHash: block.hash }; };
  const stable = async (block: { blockNumber: number; blockHash: string }) => { const after = await rpc(() => provider.getBlock(Shard.Cyprus1, block.blockNumber));
    if (after?.hash !== block.blockHash || after?.woHeader?.number !== block.blockNumber) fail('Workflow block changed during its checks.', 'INVALID_RESPONSE'); await network(); };
  const code = async (target: string, block: number) => { const raw = await rpc(() => provider.getCode(target, block));
    if (typeof raw !== 'string' || raw.length > maxBytes * 2 + 2 || !/^0x(?:[\da-fA-F]{2})*$/.test(raw)) fail('Malformed or unbounded workflow bytecode response.', 'INVALID_RESPONSE'); return raw as Hex; };
  return { rpc, snapshot, stable, code, settings };
}
function same(a: string, b: string): boolean { return address(a) === address(b); }

/** Refresh factory identities, predicted vacancies and exact simulation at a stable checked block. */
export async function prepareDAOShipLaunch(plan: DAOShipLaunchPlan, provider: PlanProvider, options: DeploymentReadOptions = {}): Promise<PreparedTransaction> {
  plan = capturePlan(plan);
  const op = operations(provider, plan.chainId, options), block = await op.snapshot(), read = { ...op.settings, blockTag: block.blockNumber, from: plan.from };
  const d = plan.deployment, factory = new ContractClient('DAOShipLauncher', d.daoShipLauncher, provider);
  const refs = await Promise.all([factory.read('daoShipSingleton', [], read), factory.read('sharesSingleton', [], read), factory.read('lootSingleton', [], read)]);
  if (!refs.every((a, i) => same(a, [d.daoShipSingleton, d.sharesSingleton, d.lootSingleton][i]!))) fail('DAO factory singletons differ from the plan.', 'PLAN_CHANGED');
  if (plan.route !== 'direct') {
    const combined = new ContractClient('DAOShipAndVaultLauncher', d.daoShipAndVaultLauncher, provider);
    const references = await Promise.all([combined.read('daoShipLauncher', [], read), combined.read('quaiVaultFactory', [], read), combined.read('multisendCallOnly', [], read)]);
    if (!references.every((a, i) => same(a, [d.daoShipLauncher, d.quaiVaultFactory, d.multisendCallOnly][i]!))) fail('Combined launcher references differ from the plan.', 'PLAN_CHANGED');
  }
  const expectedCode = [d.daoShipLauncher, d.daoShipSingleton, d.sharesSingleton, d.lootSingleton, d.multisendCallOnly,
    ...(plan.route === 'direct' ? [] : [d.daoShipAndVaultLauncher]), ...(plan.newVault ? [d.quaiVaultFactory, d.vaultSingleton] : [plan.expected.vault])];
  await Promise.all(expectedCode.map(async a => { if (await op.code(a, block.blockNumber) === '0x') fail('A launch prerequisite has no code.', 'INVALID_RESPONSE'); }));
  const empty = [plan.expected.daoShip, plan.expected.shares, plan.expected.loot, ...(plan.newVault ? [plan.expected.vault] : [])];
  await Promise.all(empty.map(async a => { if (await op.code(a, block.blockNumber) !== '0x') fail('A predicted deployment address is already occupied.', 'PLAN_CHANGED'); }));
  if (plan.newVault) {
    const v = plan.newVault;
    const prediction = await new ContractClient('QuaiVaultFactory', d.quaiVaultFactory, provider).read('predictWalletAddress', [d.daoShipAndVaultLauncher, toBeHex(v.salt, 32), v.owners, v.threshold, 0n, [plan.expected.daoShip], [d.multisendCallOnly]], read);
    if (!same(prediction, plan.expected.vault)) fail('Vault factory prediction differs from the reviewed proxy bytecode/configuration.', 'PLAN_CHANGED');
  }
  await op.rpc(() => provider.call({ to: plan.call.to, from: plan.from, value: plan.call.value, data: plan.call.data, blockTag: block.blockNumber }));
  await op.stable(block);
  return { ...plan.call, chainId: plan.chainId, from: plan.from, checkedAt: block };
}

/** Require both the underlying clone-launch event and combined event where applicable. */
export function assertDAOShipLaunchReceipt(plan: DAOShipLaunchPlan, receipt: Receipt): DAOShipLaunchPlan['expected'] {
  plan = capturePlan(plan);
  const events = parseContractEvents(receipt, 'DAOShipLauncher', plan.deployment.daoShipLauncher, 'LaunchDAOShip');
  if (events.length !== 1) throw new DaoShipsError('MISSING_EVENT', 'Expected exactly one DAOShip factory launch event.');
  const e = events[0]!.args, sender = plan.route === 'direct' ? plan.from : plan.deployment.daoShipAndVaultLauncher;
  if (![same(e.daoShip, plan.expected.daoShip), same(e.shares, plan.expected.shares), same(e.loot, plan.expected.loot), same(e.avatar, plan.expected.vault), same(e.launcher, sender)].every(Boolean)) fail('DAO launch event differs from the reviewed plan.', 'INVALID_RESPONSE');
  if (plan.route !== 'direct') {
    const combined = parseContractEvents(receipt, 'DAOShipAndVaultLauncher', plan.deployment.daoShipAndVaultLauncher, 'LaunchDAOShipAndVault');
    if (combined.length !== 1) throw new DaoShipsError('MISSING_EVENT', 'Expected exactly one combined launch event.');
    const c = combined[0]!.args;
    if (![same(c.daoShip, plan.expected.daoShip), same(c.vault, plan.expected.vault), same(c.shares, plan.expected.shares), same(c.loot, plan.expected.loot), same(c.launcher, plan.from), c.newVault === !!plan.newVault].every(Boolean)) fail('Combined launch event differs from the reviewed plan.', 'INVALID_RESPONSE');
  }
  return plan.expected;
}

/** Read setup at one caller-selected fixed block. Proposing a vault action is never completion. */
export async function pendingVaultSetupCalls(plan: DAOShipLaunchPlan, provider: Pick<Provider, 'call'>, options: ContractReadOptions & { blockTag: number }): Promise<readonly EncodedCall[]> {
  plan = capturePlan(plan);
  if (!Number.isSafeInteger(options.blockTag) || options.blockTag < 0) fail('Vault setup checks require a fixed block number.');
  const read = { ...options }, vault = new ContractClient('QuaiVault', plan.expected.vault, provider);
  const [enabled, allowed] = await Promise.all([vault.read('isModuleEnabled', [plan.expected.daoShip], read), vault.read('delegatecallAllowed', [plan.deployment.multisendCallOnly], read)]);
  return [ ...(enabled ? [] : [vault.encode('enableModule', [plan.expected.daoShip])]), ...(allowed ? [] : [vault.encode('addDelegatecallTarget', [plan.deployment.multisendCallOnly])]) ];
}

export interface DeploymentExecutionReceipt extends Receipt { hash: string; blockNumber: number; contractAddress?: string | null }
export interface DeploymentVerificationOptions extends DeploymentReadOptions {
  /** Required canonical Cyprus-1 block depth for mined receipts; default 1. This is not a finality proof. */
  confirmations?: number;
}
function confirmationDepth(options: DeploymentVerificationOptions): number {
  const value = options.confirmations ?? 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) fail('Workflow confirmations must be an integer from 1 to 10000.');
  return value;
}
/** Verify actual receipt, exact transaction/proposal identity and deployment/activation postconditions. */
export async function verifyDeploymentWorkflowStep(plan: DeploymentWorkflowPlan, stepId: string, receipt: DeploymentExecutionReceipt, provider: DeploymentWorkflowProvider, options: DeploymentVerificationOptions = {}): Promise<void> {
  plan = capturePlan(plan);
  const confirmations = confirmationDepth(options);
  receipt = { hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status, logs: [] };
  const step = plan.steps.find(s => s.id === stepId); if (!step) fail('Unknown workflow step.');
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || !/^0x[\da-fA-F]{64}$/.test(receipt.hash)) fail('Expected a mined receipt with a transaction hash.', 'INVALID_RESPONSE');
  if (receipt.status !== 1) throw new DaoShipsError(receipt.status === 0 ? 'TX_REVERTED' : 'TX_PENDING', 'Workflow step is not confirmed successfully.');
  const op = operations(provider, plan.chainId, options), latest = await op.snapshot();
  if (latest.blockNumber < receipt.blockNumber) fail('Provider is behind the workflow receipt.', 'INVALID_RESPONSE');
  if (latest.blockNumber - receipt.blockNumber + 1 < confirmations) throw new DaoShipsError('TX_PENDING', 'Workflow receipt has not reached the requested confirmation depth.', { hash: receipt.hash, confirmations });
  const read = { ...op.settings, blockTag: receipt.blockNumber, from: plan.from };
  const block = await op.rpc(() => provider.getBlock(Shard.Cyprus1, receipt.blockNumber));
  if (!block?.hash || !/^0x[\da-fA-F]{64}$/.test(block.hash) || block.woHeader?.number !== receipt.blockNumber) fail('Receipt block is unavailable.', 'INVALID_RESPONSE');
  const fixed = { blockNumber: receipt.blockNumber, blockHash: block.hash };
  const fetched = await op.rpc(() => provider.getTransactionReceipt(receipt.hash));
  if (!fetched || fetched.status !== 1 || fetched.blockNumber !== receipt.blockNumber || fetched.hash.toLowerCase() !== receipt.hash.toLowerCase() || fetched.blockHash !== block.hash) fail('Receipt is not confirmed by the selected provider.', 'INVALID_RESPONSE');
  // Use the provider receipt rather than an executor-supplied log collection.
  const actual = fetched;
  if (step.kind === 'transaction' || step.kind === 'creation') {
    const tx = await op.rpc(() => provider.getTransaction(receipt.hash));
    if (!tx || !('from' in tx) || !same(tx.from, plan.from) || tx.hash.toLowerCase() !== receipt.hash.toLowerCase() || tx.chainId !== BigInt(plan.chainId)) fail('Workflow transaction identity differs from the plan.', 'INVALID_RESPONSE');
    if (step.kind === 'creation') {
      if (tx.to != null || tx.data.toLowerCase() !== step.creationData!.toLowerCase() || tx.value !== 0n) fail('Creation transaction differs from the finalized deployment request.', 'INVALID_RESPONSE');
      if (plan.type === 'navigator' && plan.quaiCreation && tx.nonce !== plan.quaiCreation.nonce) fail('Quai CREATE nonce differs from the reviewed plan.', 'INVALID_RESPONSE');
    } else {
      const call = step.calls[0]!;
      if (!tx.to || !same(tx.to, call.to) || tx.data.toLowerCase() !== call.data.toLowerCase() || tx.value !== call.value) fail('Workflow transaction differs from the reviewed call.', 'INVALID_RESPONSE');
    }
  }
  if (plan.type === 'dao-launch') {
    if (step.id === 'launch') {
      assertDAOShipLaunchReceipt(plan, actual);
      const dao = new ContractClient('DAOShip', plan.expected.daoShip, provider);
      const [avatar, shares, loot] = await Promise.all([dao.read('avatar', [], read), dao.read('sharesToken', [], read), dao.read('lootToken', [], read)]);
      if (![same(avatar, plan.expected.vault), same(shares, plan.expected.shares), same(loot, plan.expected.loot)].every(Boolean)) fail('Launched DAO configuration differs from the plan.', 'INVALID_RESPONSE');
      const names = ['votingPeriod', 'gracePeriod', 'proposalOffering', 'quorumPercent', 'sponsorThreshold', 'minRetentionPercent', 'defaultExpiryWindow'] as const;
      const config = await Promise.all(names.map(name => dao.read(name, [], read)));
      if (!config.every((value, i) => value === BigInt(plan.parameters.initialization.governanceConfig[names[i]!]))) fail('Launched governance configuration differs from the plan.', 'INVALID_RESPONSE');
      for (const [target, name, symbol, amounts] of [[shares, plan.parameters.shareTokenName, plan.parameters.shareTokenSymbol, plan.parameters.initialization.initShareAmounts], [loot, plan.parameters.lootTokenName, plan.parameters.lootTokenSymbol, plan.parameters.initialization.initLootAmounts]] as const) {
        const token = new ContractClient('SharesERC20', target, provider);
        const [actualName, actualSymbol, supply] = await Promise.all([token.read('name', [], read), token.read('symbol', [], read), token.read('totalSupply', [], read)]);
        const expectedSupply = amounts.reduce((sum, amount, i) => sum + (BigInt(plan.parameters.initialization.initMembers[i]!) === 0n ? 0n : amount), 0n);
        if (actualName !== name || actualSymbol !== symbol || supply !== expectedSupply) fail('Launched token metadata or supply differs from the plan.', 'INVALID_RESPONSE');
      }
    }
    if (step.id === 'enable-dao-module') {
      if (!await new ContractClient('QuaiVault', plan.expected.vault, provider).read('isModuleEnabled', [plan.expected.daoShip], read)) fail('DAO vault module has not been enabled.', 'INVALID_RESPONSE');
    }
    if (step.id === 'allow-multisend' || plan.newVault) {
      if ((await pendingVaultSetupCalls(plan, provider, read)).length) fail('Vault setup has not executed: module or delegatecall permission is missing.', 'INVALID_RESPONSE');
    }
    if (plan.newVault) {
      const vault = new ContractClient('QuaiVault', plan.expected.vault, provider);
      const [owners, threshold, delay] = await Promise.all([vault.read('getOwners', [], read), vault.read('threshold', [], read), vault.read('minExecutionDelay', [], read)]);
      if (threshold !== plan.newVault.threshold || delay !== 0n || owners.length !== plan.newVault.owners.length || !owners.every((a, i) => same(a, plan.newVault!.owners[i]!))) fail('New vault owner configuration differs from the plan.', 'INVALID_RESPONSE');
    }
  } else if (step.id === 'create') {
    if (!actual.contractAddress || !same(actual.contractAddress, plan.expectedAddress)) fail('Creation receipt address differs from the finalized prediction.', 'INVALID_RESPONSE');
    const deployed = parseNavigatorDeploymentReceipt(actual, plan.expectedAddress, { daoShip: plan.daoShip, deployer: plan.from, kind: plan.kind });
    if (deployed.name !== plan.metadata.name || deployed.description !== plan.metadata.description || await op.code(plan.expectedAddress, receipt.blockNumber) === '0x') fail('Navigator deployment postconditions failed.', 'INVALID_RESPONSE');
  } else if (step.id === 'activate') {
    const requirements = getNavigatorRequirements(plan.kind);
    if (step.kind === 'dao-governance') {
      const processed = parseContractEvents(actual, 'DAOShip', plan.daoShip, 'ProcessProposal');
      if (processed.length !== 1) throw new DaoShipsError('MISSING_EVENT', 'Expected the activation governance execution receipt.');
      const proposalId = processed[0]!.args.proposal;
      assertActionSucceeded(actual, plan.daoShip, Number(proposalId));
      const proposal = await new ContractClient('DAOShip', plan.daoShip, provider).read('proposals', [proposalId], read);
      if (proposal.proposalDataHash.toLowerCase() !== hashProposalData(step.proposalData!).toLowerCase()) fail('A different governance proposal was executed.', 'INVALID_RESPONSE');
    }
    if (requirements.daoPermission) {
      const permission = await new ContractClient('DAOShip', plan.daoShip, provider).read('navigators', [plan.expectedAddress], read);
      if ((permission & requirements.daoPermission) !== requirements.daoPermission) fail('Navigator DAO permission was not activated.', 'INVALID_RESPONSE');
    } else if (requirements.vaultModule) {
      if (!await new ContractClient('QuaiVault', plan.vault, provider).read('isModuleEnabled', [plan.expectedAddress], read)) fail('Budget vault module was not activated.', 'INVALID_RESPONSE');
    } else {
      const endorsement = plan.signalEndorsement!;
      const posts = parseContractEvents(actual, 'Poster', endorsement.poster, 'NewPost');
      if (!posts.some(p => same(p.args.user, plan.vault) && p.args.content === endorsement.content && p.args.tag.hash === posterTagTopic(POSTER_TAGS.DAO_NAVIGATORS))) fail('Expected complete Signal endorsement was not posted by the vault.', 'INVALID_RESPONSE');
    }
  } else if (step.id === 'fund-treasury' && plan.treasuryFunding!.token !== ZERO) {
    const funding = plan.treasuryFunding!;
    const transfers = parseContractEvents(actual, 'SharesERC20', funding.token, 'Transfer');
    if (!transfers.some(t => same(t.args.from, plan.from) && same(t.args.to, plan.vault) && t.args.value === funding.amount)) fail('Treasury token funding transfer was not observed.', 'INVALID_RESPONSE');
  }
  await op.stable(fixed);
}

export interface DeploymentWorkflowCheckpoint {
  version: 1; planId: Hex; revision: number;
  steps: Record<string, { status: 'submitting' | 'submitted' | 'verified'; hash?: string; checkedAt?: { blockNumber: number; blockHash: string } }>;
}
export interface DeploymentWorkflowStore {
  load(planId: string): Promise<DeploymentWorkflowCheckpoint | null>;
  /** Atomic across processes: expectedRevision=null creates only if no checkpoint exists. */
  compareAndSwap(planId: string, expectedRevision: number | null, checkpoint: DeploymentWorkflowCheckpoint): Promise<boolean>;
}
export interface DeploymentWorkflowRunOptions extends DeploymentVerificationOptions {
  /** Caller authenticates the current complete set: original before activation, resulting set afterward. */
  verifyCurrentSignalEndorsement?: (plan: NavigatorDeploymentPlan, stage: 'before-activation' | 'after-activation') => Promise<boolean>;
}
export interface DeploymentStepExecutor {
  /** Must persist the hash through onSubmitted immediately after broadcast, before any wait. */
  execute(plan: DeploymentWorkflowPlan, step: DeploymentWorkflowStep, context: {
    id: string; prepared: PreparedDeploymentStep; onSubmitted(hash: string): Promise<void>;
  }): Promise<DeploymentExecutionReceipt>;
}
export interface PreparedDeploymentStep {
  readonly checkedAt: { blockNumber: number; blockHash: string };
  readonly calls: readonly EncodedCall[];
  readonly transaction?: PreparedTransaction;
  readonly alreadySatisfied: boolean;
}
/** Existing module grants can be verified from state without replaying enableModule. */
function canVerifyExistingPermission(plan: DeploymentWorkflowPlan, step: DeploymentWorkflowStep): boolean {
  return step.kind === 'vault' || (plan.type === 'navigator' && step.id === 'activate' && getNavigatorRequirements(plan.kind).vaultModule);
}
/** Fresh chain prerequisites before an executor receives authority to submit a step. */
export async function prepareDeploymentWorkflowStep(plan: DeploymentWorkflowPlan, stepId: string, provider: PlanProvider, options: DeploymentReadOptions = {}): Promise<PreparedDeploymentStep> {
  plan = capturePlan(plan);
  const step = plan.steps.find(s => s.id === stepId); if (!step) fail('Unknown deployment step.');
  if (plan.type === 'dao-launch' && stepId === 'launch') {
    const transaction = await prepareDAOShipLaunch(plan, provider, options);
    return freeze({ checkedAt: transaction.checkedAt, calls: step.calls, transaction, alreadySatisfied: false });
  }
  const op = operations(provider, plan.chainId, options), checkedAt = await op.snapshot(), read = { ...op.settings, blockTag: checkedAt.blockNumber, from: plan.from };
  let calls = step.calls;
  if (plan.type === 'dao-launch') {
    const missing = await pendingVaultSetupCalls(plan, provider, read);
    calls = step.calls.filter(call => missing.some(m => m.data === call.data));
  } else {
    const dao = new ContractClient('DAOShip', plan.daoShip, provider);
    if (!same(await dao.read('avatar', [], read), plan.vault)) fail('Navigator workflow vault no longer matches the DAO.', 'PLAN_CHANGED');
    if (await op.code(plan.daoShip, checkedAt.blockNumber) === '0x' || await op.code(plan.vault, checkedAt.blockNumber) === '0x') fail('DAO or vault prerequisite is missing.', 'INVALID_RESPONSE');
    if (step.kind === 'creation') {
      if (await op.code(plan.expectedAddress, checkedAt.blockNumber) !== '0x') fail('The finalized navigator CREATE address is occupied.', 'PLAN_CHANGED');
      if (plan.quaiCreation) {
        if (!provider.getTransactionCount) fail('Quai CREATE preparation requires provider.getTransactionCount.');
        if (await op.rpc(() => provider.getTransactionCount!(plan.from, 'pending')) !== plan.quaiCreation.nonce) fail('Quai CREATE nonce changed; rebuild the grinded plan before submitting.', 'PLAN_CHANGED');
      }
    } else {
      const nav = new ContractClient(plan.kind, plan.expectedAddress, provider);
      // These common signatures are present on every canonical navigator.
      const [actualDao, kind] = await Promise.all([nav.read('daoShip', [], read), nav.read('navigatorType', [], read)]);
      if (!same(actualDao as string, plan.daoShip) || kind !== plan.kind) fail('Navigator identity differs from the deployment plan.', 'PLAN_CHANGED');
    }
    if (step.id === 'activate' && getNavigatorRequirements(plan.kind).vaultModule) {
      const enabled = await new ContractClient('QuaiVault', plan.vault, provider).read('isModuleEnabled', [plan.expectedAddress], read);
      if (enabled) calls = [];
    }
  }
  let transaction: PreparedTransaction | undefined;
  if (step.kind === 'transaction') {
    const call = step.calls[0]!;
    await op.rpc(() => provider.call({ to: call.to, from: plan.from, data: call.data, value: call.value, blockTag: checkedAt.blockNumber }));
    transaction = { ...call, chainId: plan.chainId, from: plan.from, checkedAt };
  }
  await op.stable(checkedAt);
  return freeze({ checkedAt, calls, ...(transaction ? { transaction } : {}), alreadySatisfied: canVerifyExistingPermission(plan, step) && !calls.length });
}
/**
 * Execute/reconcile one ordered step. Wallet/native-CREATE/governance/vault execution is
 * supplied explicitly by kind. Atomic checkpoint revisions prevent competing advances
 * from submitting the same step. Executor-internal approvals/proposals need their own
 * durable transaction recovery IDs derived from the supplied context ID.
 * An uncertain submitting state blocks a retry; reconcile it with the transaction recovery
 * store and record its known hash before resuming. There is never an automatic resend.
 */
export async function advanceDeploymentWorkflow(plan: DeploymentWorkflowPlan, store: DeploymentWorkflowStore,
  executors: Partial<Record<DeploymentWorkflowStep['kind'], DeploymentStepExecutor>>, provider: DeploymentWorkflowProvider,
  options: DeploymentWorkflowRunOptions = {}): Promise<DeploymentWorkflowCheckpoint> {
  plan = capturePlan(plan);
  const runOptions = { ...options };
  confirmationDepth(runOptions);
  const loaded = await store.load(plan.id);
  const serialized = loaded ? JSON.stringify(loaded) : '';
  if (serialized.length > 16_384) fail('Deployment checkpoint exceeds the size limit.');
  const checkpoint: DeploymentWorkflowCheckpoint = loaded ? JSON.parse(serialized) as DeploymentWorkflowCheckpoint : { version: 1, planId: plan.id, revision: 0, steps: {} };
  if (checkpoint.version !== 1 || checkpoint.planId !== plan.id || !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 0 || !checkpoint.steps || typeof checkpoint.steps !== 'object' || Array.isArray(checkpoint.steps) || Object.keys(checkpoint.steps).some(id => !plan.steps.some(s => s.id === id))) fail('Checkpoint does not belong to this deployment plan.');
  let persistedRevision: number | null = loaded ? checkpoint.revision : null;
  for (const [id, saved] of Object.entries(checkpoint.steps)) {
    if (!saved || !['submitting', 'submitted', 'verified'].includes(saved.status) || (saved.hash !== undefined && !/^0x[\da-fA-F]{64}$/.test(saved.hash))) fail('Malformed deployment checkpoint state.');
    if (saved.status === 'verified' && !saved.hash && (!saved.checkedAt || !Number.isSafeInteger(saved.checkedAt.blockNumber) || saved.checkedAt.blockNumber < 0 || typeof saved.checkedAt.blockHash !== 'string')) fail('Verified step has no receipt or checked postcondition.');
    if (plan.steps.find(s => s.id === id)!.dependsOn.some(dep => checkpoint.steps[dep]?.status !== 'verified')) fail('Persisted deployment step violates dependency order.');
  }
  for (const step of plan.steps) {
    const saved = checkpoint.steps[step.id];
    if (saved?.status === 'verified') {
      const op = operations(provider, plan.chainId, runOptions);
      if (saved.hash) {
        const actual = await op.rpc(() => provider.getTransactionReceipt(saved.hash!));
        if (!actual) throw new DaoShipsError('TX_PENDING', 'Previously verified receipt disappeared; reconcile before continuing.', { hash: saved.hash });
        await verifyDeploymentWorkflowStep(plan, step.id, actual, provider, runOptions);
      } else if (!canVerifyExistingPermission(plan, step)) fail('Only checked vault postconditions may omit an execution receipt.');
      const block = await op.snapshot(), read = { ...op.settings, blockTag: block.blockNumber, from: plan.from };
      if (plan.type === 'dao-launch' && (step.kind === 'vault' || plan.newVault)) {
        const missing = await pendingVaultSetupCalls(plan, provider, read);
        if (plan.newVault ? missing.length > 0 : missing.some(call => step.calls.some(c => c.data === call.data))) fail('Previously verified vault authorization was revoked.', 'PLAN_CHANGED');
      } else if (plan.type === 'navigator' && step.id === 'activate') {
        const requirements = getNavigatorRequirements(plan.kind);
        if (requirements.daoPermission) {
          const current = await new ContractClient('DAOShip', plan.daoShip, provider).read('navigators', [plan.expectedAddress], read);
          if ((current & requirements.daoPermission) !== requirements.daoPermission) fail('Navigator permission was revoked after activation.', 'PLAN_CHANGED');
        } else if (requirements.vaultModule) {
          if (!await new ContractClient('QuaiVault', plan.vault, provider).read('isModuleEnabled', [plan.expectedAddress], read)) fail('Navigator vault access was revoked after activation.', 'PLAN_CHANGED');
        } else if (!runOptions.verifyCurrentSignalEndorsement || !await op.rpc(() => runOptions.verifyCurrentSignalEndorsement!(plan, 'after-activation'))) {
          fail('Resuming Signal activation requires current authenticated endorsement verification.', 'PLAN_CHANGED');
        }
      }
      await op.stable(block);
      continue;
    }
    if (step.dependsOn.some(id => checkpoint.steps[id]?.status !== 'verified')) fail('Workflow prerequisites are not verified.');
    if (saved?.status === 'submitting') throw new DaoShipsError('TX_PENDING', 'Step submission is uncertain; recover its transaction before retrying.', { planId: plan.id, stepId: step.id });
    const persist = async () => { try {
      if (checkpoint.revision >= Number.MAX_SAFE_INTEGER) fail('Deployment checkpoint revision exhausted.');
      const next = { ...checkpoint, revision: (persistedRevision ?? 0) + 1 };
      if (!await store.compareAndSwap(plan.id, persistedRevision, JSON.parse(JSON.stringify(next)) as DeploymentWorkflowCheckpoint)) throw new DaoShipsError('PLAN_CHANGED', 'Another worker changed this deployment checkpoint; no retry is authorized.');
      checkpoint.revision = next.revision; persistedRevision = next.revision;
    }
      catch (cause) { throw new DaoShipsError('PERSISTENCE_ERROR', 'Could not persist deployment checkpoint.', { planId: plan.id, stepId: step.id, hash: checkpoint.steps[step.id]?.hash }, { cause }); } };
    let receipt: DeploymentExecutionReceipt;
    if (saved) {
      if (saved.status !== 'submitted' || !saved.hash || !/^0x[\da-fA-F]{64}$/.test(saved.hash)) fail('Malformed submitted workflow checkpoint.');
      const observed = await operations(provider, plan.chainId, runOptions).rpc(() => provider.getTransactionReceipt(saved.hash!));
      if (!observed) throw new DaoShipsError('TX_PENDING', 'Submitted workflow step is still pending.', { hash: saved.hash, stepId: step.id });
      receipt = observed;
    } else {
      const executor = executors[step.kind]; if (!executor) fail(`Missing explicit ${step.kind} executor for step ${step.id}.`);
      const prepared = await prepareDeploymentWorkflowStep(plan, step.id, provider, runOptions);
      if (plan.type === 'navigator' && plan.kind === 'SignalNavigator' && step.id === 'activate') {
        const op = operations(provider, plan.chainId, runOptions);
        if (!runOptions.verifyCurrentSignalEndorsement || !await op.rpc(() => runOptions.verifyCurrentSignalEndorsement!(plan, 'before-activation'))) fail('Signal endorsement changed or is not authenticated before activation.', 'PLAN_CHANGED');
      }
      if (prepared.alreadySatisfied) {
        checkpoint.steps[step.id] = { status: 'verified', checkedAt: prepared.checkedAt }; await persist(); return checkpoint;
      }
      checkpoint.steps[step.id] = { status: 'submitting' }; await persist();
      receipt = await executor.execute(plan, step, { id: `${plan.id}:${step.id}`, prepared, onSubmitted: async hash => {
        if (!/^0x[\da-fA-F]{64}$/.test(hash)) fail('Executor returned an invalid transaction hash.', 'INVALID_RESPONSE');
        const current = checkpoint.steps[step.id];
        if (current?.hash && current.hash.toLowerCase() !== hash.toLowerCase()) fail('Executor attempted more than one submission for a step.', 'INVALID_RESPONSE');
        checkpoint.steps[step.id] = { status: 'submitted', hash }; await persist();
      } });
      receipt = { hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status, logs: [] };
      if (!checkpoint.steps[step.id]?.hash) throw new DaoShipsError('PERSISTENCE_ERROR', 'Executor did not persist its submitted hash; inspect the wallet before proceeding.', { planId: plan.id, stepId: step.id });
    }
    if (receipt.hash.toLowerCase() !== checkpoint.steps[step.id]!.hash!.toLowerCase()) fail('Execution receipt differs from the persisted transaction hash.', 'INVALID_RESPONSE');
    await verifyDeploymentWorkflowStep(plan, step.id, receipt, provider, runOptions);
    checkpoint.steps[step.id] = { status: 'verified', hash: checkpoint.steps[step.id]!.hash! }; await persist();
    return checkpoint;
  }
  return checkpoint;
}

/** Recover a lost submission acknowledgment using a mined, independently verified receipt.
 * Pending hashes cannot advance state. This rechecks earlier prerequisites and atomically
 * promotes only the first unfinished step, without giving an executor broadcast authority.
 */
export async function reconcileDeploymentWorkflowStep(plan: DeploymentWorkflowPlan, store: DeploymentWorkflowStore,
  stepId: string, transactionHash: string, provider: DeploymentWorkflowProvider,
  options: DeploymentWorkflowRunOptions & { /** Explicit original hash for a same-intent, same-nonce repricing. */ replacementOf?: string } = {}): Promise<DeploymentWorkflowCheckpoint> {
  plan = capturePlan(plan);
  const settings = { ...options };
  if (!plan.steps.some(step => step.id === stepId) || !/^0x[\da-fA-F]{64}$/.test(transactionHash)) fail('Invalid deployment reconciliation step or hash.');
  const loaded = await store.load(plan.id);
  if (!loaded) fail('No uncertain deployment checkpoint exists.');
  const json = JSON.stringify(loaded);
  if (json.length > 16_384) fail('Deployment checkpoint exceeds the size limit.');
  const checkpoint = JSON.parse(json) as DeploymentWorkflowCheckpoint;
  const saved = checkpoint.steps?.[stepId];
  if (!saved || !['submitting', 'submitted'].includes(saved.status)) fail('Step is not awaiting this transaction acknowledgment.');
  if (saved.hash && saved.hash.toLowerCase() !== transactionHash.toLowerCase()) {
    if (settings.replacementOf?.toLowerCase() !== saved.hash.toLowerCase()) fail('A replacement requires its persisted original transaction hash.');
    const op = operations(provider, plan.chainId, settings);
    const [original, candidate] = await Promise.all([op.rpc(() => provider.getTransaction(saved.hash!)), op.rpc(() => provider.getTransaction(transactionHash))]);
    if (!original || !candidate || !('from' in original) || !('from' in candidate)
      || original.hash.toLowerCase() !== saved.hash.toLowerCase() || candidate.hash.toLowerCase() !== transactionHash.toLowerCase()
      || original.chainId !== BigInt(plan.chainId) || candidate.chainId !== original.chainId || !same(original.from, candidate.from)
      || !Number.isSafeInteger(original.nonce) || original.nonce < 0 || original.nonce >= Number.MAX_SAFE_INTEGER
      || original.nonce !== candidate.nonce || (original.to === null ? candidate.to !== null : !candidate.to || !same(original.to, candidate.to))
      || original.data.toLowerCase() !== candidate.data.toLowerCase() || original.value !== candidate.value) fail('Replacement is not proven to be a same-nonce repricing of the original intent.', 'INVALID_RESPONSE');
  }
  if (plan.steps.find(step => checkpoint.steps[step.id]?.status !== 'verified')?.id !== stepId) fail('Only the first unfinished deployment step can be reconciled.');
  checkpoint.steps[stepId] = { status: 'submitted', hash: transactionHash };
  return advanceDeploymentWorkflow(plan, {
    load: async () => checkpoint,
    compareAndSwap: (id, revision, next) => store.compareAndSwap(id, revision, next),
  }, {}, provider, settings);
}
