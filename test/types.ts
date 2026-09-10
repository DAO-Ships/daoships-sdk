import { ContractClient, DaoShipsIndexer, Navigator, parseContractEvents, type Receipt } from '../src/index.js';

const token = new ContractClient('SharesERC20', '0x0011111111111111111111111111111111111111');
const balance: Promise<bigint> = token.read('balanceOf', ['0x00']);
const symbol: Promise<string> = token.read('symbol', []);
token.encode('approve', ['0x00', 1n]);
// @ts-expect-error Unknown ABI method.
token.encode('notAFunction', []);
// @ts-expect-error ABI integers cannot silently accept JS numbers.
token.encode('approve', ['0x00', 1]);
// @ts-expect-error Transaction methods are not view reads.
token.read('transfer', ['0x00', 1n]);
// @ts-expect-error Reads cannot be encoded as transaction methods.
token.encode('symbol', []);
// @ts-expect-error Wrong argument count.
token.read('balanceOf', []);
const poster = new ContractClient('Poster', '0x00');
poster.encode('post(string,string)', ['hello', 'tag']);
// @ts-expect-error Overloaded names require the full signature.
poster.encode('post', ['hello', 'tag']);

const navigator = new Navigator('SignalNavigator', '0x00');
// @ts-expect-error Subscription methods are not methods of a SignalNavigator.
navigator.encode('collect', ['0x00']);

declare const receipt: Receipt;
const events = parseContractEvents(receipt, 'DAOShip', '0x00', 'ProcessProposal');
const passed: boolean | undefined = events[0]?.args.passed;
// @ts-expect-error Events are checked against their contract ABI.
parseContractEvents(receipt, 'Poster', '0x00', 'ProcessProposal');

const indexer = new DaoShipsIndexer({ url: 'https://example.test', key: 'public', schema: 'testnet' });
// @ts-expect-error Internal indexer tables are not public SDK resources.
indexer.list('processed_logs');
void balance; void symbol; void passed;

const posterEvents = parseContractEvents(receipt, 'Poster', '0x00', 'NewPost');
// Dynamic indexed string is unavailable as plaintext; quais returns an Indexed object.
const topicHash: string | null | undefined = posterEvents[0]?.args.tag.hash;
// @ts-expect-error An indexed string cannot be exposed as a recovered plaintext string.
const plaintextTag: string = posterEvents[0]!.args.tag;
void topicHash; void plaintextTag;

// Website/indexer integration queries preserve scalar/path/table relationships.
const exactCount: Promise<bigint> = indexer.count('members', { where: [{ any: [
  { column: 'shares', operator: 'gt', value: 0n },
  { column: 'loot', operator: 'gt', value: '0' },
] }] });
indexer.list('records', { where: [{ all: [
  { column: 'content_json', path: ['proposalId'], operator: 'eq', value: 1 },
  { any: [{ column: 'dao_id', operator: 'is', value: null }, { column: 'tag', operator: 'ilike', value: '%profile%' }] },
] }] });
// @ts-expect-error Unknown indexer columns stay invalid inside nested groups.
indexer.list('records', { where: [{ any: [{ column: 'missing', operator: 'eq', value: 'x' }] }] });
// @ts-expect-error JSON path conditions require a JSON column.
indexer.list('records', { where: [{ column: 'tag', path: ['nested'], operator: 'eq', value: 'x' }] });
// @ts-expect-error JSON columns cannot be scalar-filtered without a path.
indexer.list('records', { where: [{ column: 'content_json', operator: 'eq', value: 'x' }] });
// @ts-expect-error Numeric columns do not accept wildcard text operations.
indexer.list('members', { where: [{ column: 'shares', operator: 'ilike', value: '%' }] });
// @ts-expect-error Scalar balance comparisons require exact decimal strings or bigint.
indexer.count('members', { where: [{ column: 'shares', operator: 'gt', value: 0 }] });
// @ts-expect-error Internal tables cannot be counted.
indexer.count('processed_logs');
// @ts-expect-error Counts cover the whole filtered result and do not accept pagination.
indexer.count('daos', { limit: 1 });
const summaries = indexer.listProposalSummaries('0x00');
summaries.then(page => {
  const id: string | undefined = page.items[0]?.proposal_id;
  // @ts-expect-error Encoded actions are intentionally absent from summaries.
  const payload = page.items[0]?.proposal_data;
  void id; void payload;
});
void exactCount;

import { buildTokenApprovalPlan, probeTokenPermit, buildExternalPermitTypedData, DaoShipsData, watchIndexer,
  buildDAOShipLaunchPlan, type DAOShipLaunchInput, type TransactionRecoveryStore, type DeploymentWorkflowStore,
  type PermitProbe, type RecoveryRecord, type DeploymentWorkflowCheckpoint } from '../src/index.js';
declare const launchInput: DAOShipLaunchInput;
const launchPlan = buildDAOShipLaunchPlan(launchInput);
// @ts-expect-error Deployment plans cannot be mutated after review.
launchPlan.steps.push(launchPlan.steps[0]);
// @ts-expect-error Vault route inputs require owners, threshold, salt and proxy creation bytecode.
buildDAOShipLaunchPlan({ chainId: 15000, from: '0x00', deployment: launchInput.deployment, parameters: launchInput.parameters, route: 'new-vault' });
// @ts-expect-error Allowances use exact integer values.
buildTokenApprovalPlan({ token: '0x00', owner: '0x00', spender: '0x00', currentAllowance: 0n, requiredAllowance: 1 });
declare const probe: PermitProbe;
// @ts-expect-error Unsupported permit probes cannot produce signable data.
buildExternalPermitTypedData(probe, { spender: '0x00', value: 1n, deadline: 10n });
if (probe.supported) buildExternalPermitTypedData(probe, { spender: '0x00', value: 1n, deadline: 10n });
// @ts-expect-error Restart-safe recovery requires atomic compare-and-swap storage.
const unsafeRecoveryStore: TransactionRecoveryStore = { read: async () => null, save: async (_record: RecoveryRecord) => {} };
// @ts-expect-error Deployment checkpoints also require compare-and-swap.
const unsafeDeploymentStore: DeploymentWorkflowStore = { load: async () => null, save: async (_record: DeploymentWorkflowCheckpoint) => {} };
const data = new DaoShipsData(indexer);
data.getDaoProfile('0x00', { chainId: 15000 });
// @ts-expect-error Joined reads require an expected chain identity.
data.getDaoProfile('0x00', {});
// @ts-expect-error Realtime reconciliation remains limited to public indexer tables.
watchIndexer(indexer, 'processed_logs', {});
void [probeTokenPermit, unsafeRecoveryStore, unsafeDeploymentStore];

import { connectDaoShipsSupabase, type DaoShipsSupabaseOptions } from '../dist/index.js';
const hosted: DaoShipsSupabaseOptions = { network: 'testnet', health: { expectedBlock: 100n } };
const hostedConnection = connectDaoShipsSupabase(hosted);
// @ts-expect-error Hosted connections must select a network explicitly.
connectDaoShipsSupabase({});
// @ts-expect-error Development schemas require a supported network with a schema override.
connectDaoShipsSupabase({ network: 'dev' });
// @ts-expect-error Freshness/lag requirements preserve exact block numbers.
connectDaoShipsSupabase({ network: 'testnet', health: { expectedBlock: 100 } });
void hostedConnection;

import { fetchIpfsBytecode, fetchIpfsAbi, resolveIpfsUrl, assertRecoveryStoreConformance,
  type AdapterConformanceReport } from '../dist/index.js';
fetchIpfsAbi({ resource: 'ipfs://reviewed-cid' });
// @ts-expect-error Downloaded bytecode always requires a trusted expected hash.
fetchIpfsBytecode({ resource: 'ipfs://reviewed-cid' });
// @ts-expect-error Only explicit contract/content gateway purposes are supported.
resolveIpfsUrl('reviewed-cid', 'automatic');
// @ts-expect-error Canonical ordering is an explicit boolean capability.
connectDaoShipsSupabase({ network: 'testnet', recordOrdering: 'true' });
declare const adapterReport: AdapterConformanceReport;
// @ts-expect-error Conformance never certifies production durability.
const certified: 'certified' = adapterReport.durability;
void [assertRecoveryStoreConformance, certified];
