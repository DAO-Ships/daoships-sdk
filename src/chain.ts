import { Interface, Shard, ZeroAddress, isQuaiAddress, checkResultErrors, type Provider } from 'quais';
import { DAO_SHIP_ABI } from './abi.js';
import { DaoShipsError } from './errors.js';
import { hashProposalData } from './encoding.js';
import { address, hex, proposalId, uint, type Hex } from './values.js';
import { CONTRACT_ABIS } from './abis.js';
import type { EncodedCall } from './contracts.js';
import { quoteRagequit } from './conveniences.js';
import { callProvider } from './provider-call.js';

const daoInterface = new Interface(DAO_SHIP_ABI);
const tokenInterface = new Interface(CONTRACT_ABIS.SharesERC20);
const vaultInterface = new Interface(['function isModuleEnabled(address module) view returns (bool)']);
function cyprusAddress(value: string): Hex {
  const result = address(value);
  if (!result.toLowerCase().startsWith('0x00') || !isQuaiAddress(result)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'This prototype requires Cyprus-1 Quai ledger addresses.');
  }
  return result;
}
export type ChainProvider = Pick<Provider, 'getNetwork' | 'getBlock' | 'call'> & Partial<Pick<Provider, 'getBalance'>>;
export interface ChainOptions {
  /** Maximum wait per provider operation; default 30 seconds. */
  timeoutMs?: number;
  /** Maximum eth_call response bytes before ABI decoding; default 1 MiB. */
  maxResponseBytes?: number;
}
export interface ChainSnapshot { blockNumber: number; blockHash: string; timestamp: number }
export interface DaoConfiguration {
  address: Hex; avatar: Hex; sharesToken: Hex; lootToken: Hex;
  votingPeriod: bigint; gracePeriod: bigint; proposalOffering: bigint; quorumPercent: bigint;
  sponsorThreshold: bigint; minRetentionPercent: bigint; defaultExpiryWindow: bigint;
  adminLocked: boolean; managerLocked: boolean; governorLocked: boolean;
  checkedAt: ChainSnapshot;
}
export interface MemberSnapshot {
  account: Hex; shares: bigint; loot: bigint; votingPower: bigint; delegate: Hex; checkedAt: ChainSnapshot;
}
export interface TreasurySnapshot {
  avatar: Hex; tokens: { address: Hex; balance: bigint }[]; checkedAt: ChainSnapshot;
}
export enum ProposalState {
  Unborn, Submitted, Voting, Cancelled, Grace, Ready, Processed, Defeated, Expired,
}
export interface ProposalSnapshot {
  dao: Hex; proposalId: number; chainId: number; blockNumber: number; blockHash: string;
  state: ProposalState; cancelled: boolean; processed: boolean; passed: boolean; actionFailed: boolean;
}
export interface PreparedTransaction {
  chainId: number; from: Hex; to: Hex; data: Hex; value: bigint;
  operation: string;
  checkedAt: { blockNumber: number; blockHash: string };
}

/** Chain reads and unsigned preparations. The caller owns provider lifetime and signing. */
export class DaoShipsChain {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(private readonly provider: ChainProvider, readonly chainId: number, options: ChainOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Chain timeout and response byte bounds must be positive integers.');
    }
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'chainId must be a positive safe integer.');
    }
  }

  private rpc<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const deadline = performance.now() + this.timeoutMs;
      const timer = setTimeout(() => reject(new DaoShipsError('TIMEOUT', 'Chain provider operation timed out.')), this.timeoutMs);
      Promise.resolve().then(operation).then(value => { clearTimeout(timer);
        if (performance.now() >= deadline) reject(new DaoShipsError('TIMEOUT', 'Chain provider operation timed out.')); else resolve(value);
      }, cause => { clearTimeout(timer); reject(cause); });
    });
  }

  private async snapshot(evmTime = false) {
    try { return await this.readSnapshot(evmTime); }
    catch (cause) {
      if (cause instanceof DaoShipsError) throw cause;
      throw new DaoShipsError('CHAIN_ERROR', 'Unable to read the RPC network or latest block.', {}, { cause });
    }
  }

  private async readSnapshot(evmTime: boolean) {
    const network = await this.rpc(() => this.provider.getNetwork());
    if (network.chainId !== BigInt(this.chainId)) {
      throw new DaoShipsError('CHAIN_MISMATCH', 'RPC chain does not match the configured chain.',
        { expected: this.chainId, actual: network.chainId.toString() });
    }
    const block = await this.rpc(() => this.provider.getBlock(Shard.Cyprus1, 'latest'));
    if (typeof block?.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(block.hash)) throw new DaoShipsError('CHAIN_ERROR', 'Could not read a mined Cyprus-1 block.');
    const blockNumber = block.woHeader.number;
    let timestamp = Number(block.woHeader.timestamp);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0 || !Number.isSafeInteger(timestamp) || timestamp < 1) {
      throw new DaoShipsError('INVALID_RESPONSE', 'Invalid Cyprus-1 block number or timestamp.');
    }
    if (evmTime && blockNumber > 0) {
      // Quai's EVM TIMESTAMP is the parent work object's time, not the
      // selected work object's time (go-quai/core/evm.go: NewEVMBlockContext).
      // Keep calls pinned to this block's state, and verify the parent link.
      const parent = await this.rpc(() => this.provider.getBlock(Shard.Cyprus1, blockNumber - 1));
      const parentTime = Number(parent?.woHeader.timestamp);
      if (typeof parent?.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(parent.hash)
        || parent.hash.toLowerCase() !== block.woHeader.parentHash?.toLowerCase()
        || parent.woHeader.number !== blockNumber - 1
        || !Number.isSafeInteger(parentTime) || parentTime < 1 || parentTime > timestamp) {
        throw new DaoShipsError('CHAIN_ERROR', 'Could not verify the EVM timestamp parent.', { blockNumber });
      }
      timestamp = parentTime;
    }
    return { blockNumber, blockHash: block.hash, timestamp };
  }

  /** Fail closed if number-pinned calls spanned a reorg or a provider network switch. */
  private async verifySnapshot(block: { blockNumber: number; blockHash: string }): Promise<void> {
    try {
      const [network, canonical] = await Promise.all([
        this.rpc(() => this.provider.getNetwork()), this.rpc(() => this.provider.getBlock(Shard.Cyprus1, block.blockNumber)),
      ]);
      if (network.chainId !== BigInt(this.chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'RPC network changed during the snapshot.');
      if (canonical?.hash?.toLowerCase() !== block.blockHash.toLowerCase() || canonical?.woHeader.number !== block.blockNumber) {
        throw new DaoShipsError('CHAIN_ERROR', 'Snapshot block changed during chain reads; prepare again.', { blockNumber: block.blockNumber });
      }
    } catch (cause) {
      if (cause instanceof DaoShipsError) throw cause;
      throw new DaoShipsError('CHAIN_ERROR', 'Unable to verify the snapshot block.', {}, { cause });
    }
  }

  private async read(to: string, method: string, args: readonly unknown[], block: number, iface = daoInterface) {
    const target = cyprusAddress(to);
    try {
      const data = await this.rpc(() => this.provider.call({ from: ZeroAddress, to: target, data: iface.encodeFunctionData(method, args), blockTag: block }));
      if (typeof data !== 'string' || data.length > this.maxResponseBytes * 2 + 2 || !/^0x(?:[\da-fA-F]{2})*$/.test(data)) {
        throw new DaoShipsError('INVALID_RESPONSE', 'Chain call response is malformed or exceeds the byte limit.');
      }
      const result = iface.decodeFunctionResult(method, data);
      if (checkResultErrors(result).length) throw new DaoShipsError('INVALID_RESPONSE', 'Chain call response contains invalid ABI values.');
      return result;
    } catch (cause) {
      if (cause instanceof DaoShipsError) throw cause;
      throw new DaoShipsError('CHAIN_ERROR', `Chain read failed: ${method}.`, { to: target, blockNumber: block }, { cause });
    }
  }

  private async proposal(dao: string, id: number, block: { blockNumber: number; blockHash: string }): Promise<ProposalSnapshot> {
    const to = address(dao);
    proposalId(id);
    const [state, flags] = await Promise.all([
      this.read(to, 'state', [id], block.blockNumber),
      this.read(to, 'getProposalStatus', [id], block.blockNumber),
    ]);
    const status = Number(state[0]);
    if (!Number.isInteger(status) || status < 0 || status > 8) {
      throw new DaoShipsError('INVALID_RESPONSE', 'Unknown on-chain proposal state.');
    }
    return { dao: to, proposalId: id, chainId: this.chainId, ...block, state: status,
      cancelled: flags[0][0], processed: flags[0][1], passed: flags[0][2], actionFailed: flags[0][3] };
  }

  async getProposal(dao: string, id: number): Promise<ProposalSnapshot> {
    const block = await this.snapshot();
    const result = await this.proposal(dao, id, block);
    await this.verifySnapshot(block);
    return result;
  }

  /** Current configuration from one chain block, independent of indexer availability. */
  async getDao(dao: string): Promise<DaoConfiguration> {
    const checkedAt = await this.snapshot();
    const methods = ['avatar', 'sharesToken', 'lootToken', 'votingPeriod', 'gracePeriod', 'proposalOffering',
      'quorumPercent', 'sponsorThreshold', 'minRetentionPercent', 'defaultExpiryWindow',
      'adminLock', 'managerLock', 'governorLock'] as const;
    const values = await Promise.all(methods.map(method => this.read(dao, method, [], checkedAt.blockNumber)));
    await this.verifySnapshot(checkedAt);
    return { address: cyprusAddress(dao), avatar: address(values[0]![0]), sharesToken: address(values[1]![0]),
      lootToken: address(values[2]![0]), votingPeriod: BigInt(values[3]![0]), gracePeriod: BigInt(values[4]![0]),
      proposalOffering: BigInt(values[5]![0]), quorumPercent: BigInt(values[6]![0]), sponsorThreshold: BigInt(values[7]![0]),
      minRetentionPercent: BigInt(values[8]![0]), defaultExpiryWindow: BigInt(values[9]![0]),
      adminLocked: values[10]![0], managerLocked: values[11]![0], governorLocked: values[12]![0], checkedAt };
  }

  async getMember(dao: string, account: string): Promise<MemberSnapshot> {
    const checkedAt = await this.snapshot();
    const member = cyprusAddress(account);
    const [shares, loot] = await Promise.all([
      this.read(dao, 'sharesToken', [], checkedAt.blockNumber), this.read(dao, 'lootToken', [], checkedAt.blockNumber),
    ]);
    const [sharesBalance, lootBalance, votes, delegate] = await Promise.all([
      this.read(shares[0], 'balanceOf', [member], checkedAt.blockNumber, tokenInterface),
      this.read(loot[0], 'balanceOf', [member], checkedAt.blockNumber, tokenInterface),
      this.read(shares[0], 'getCurrentVotes', [member], checkedAt.blockNumber, tokenInterface),
      this.read(shares[0], 'delegates', [member], checkedAt.blockNumber, tokenInterface),
    ]);
    await this.verifySnapshot(checkedAt);
    return { account: member, shares: BigInt(sharesBalance[0]), loot: BigInt(lootBalance[0]),
      votingPower: BigInt(votes[0]), delegate: address(delegate[0]), checkedAt };
  }

  async getCapabilities(dao: string, account: string) {
    const checkedAt = await this.snapshot();
    const [permissions, admin, manager, governor] = await Promise.all([
      this.read(dao, 'navigators', [address(account)], checkedAt.blockNumber),
      this.read(dao, 'isAdmin', [address(account)], checkedAt.blockNumber),
      this.read(dao, 'isManager', [address(account)], checkedAt.blockNumber),
      this.read(dao, 'isGovernor', [address(account)], checkedAt.blockNumber),
    ]);
    await this.verifySnapshot(checkedAt);
    return { permissions: BigInt(permissions[0]), isAdmin: Boolean(admin[0]), isManager: Boolean(manager[0]),
      isGovernor: Boolean(governor[0]), checkedAt };
  }

  async getTreasury(dao: string): Promise<TreasurySnapshot> {
    const checkedAt = await this.snapshot();
    const result = await this.treasuryAt(dao, checkedAt);
    await this.verifySnapshot(checkedAt);
    return result;
  }

  private async treasuryAt(dao: string, checkedAt: ChainSnapshot): Promise<TreasurySnapshot> {
    const [vault, guild] = await Promise.all([
      this.read(dao, 'avatar', [], checkedAt.blockNumber), this.read(dao, 'getGuildTokens', [], checkedAt.blockNumber),
    ]);
    const avatar = address(vault[0]);
    if (!Array.isArray(guild[0]) || guild[0].length > 20) throw new DaoShipsError('INVALID_RESPONSE', 'Treasury response exceeds the protocol guild-token limit.');
    const guildAddresses = (guild[0] as readonly string[]).map(token => address(token));
    if (new Set(guildAddresses).size !== guildAddresses.length) throw new DaoShipsError('INVALID_RESPONSE', 'Treasury response contains duplicate guild tokens.');
    const tokens = await Promise.all(guildAddresses.map(async token => {
      const target = address(token);
      if (BigInt(target) === 0n) {
        if (!this.provider.getBalance) throw new DaoShipsError('CHAIN_ERROR', 'Provider.getBalance is required for native treasury balances.');
        try { return { address: target, balance: uint(await this.rpc(() => this.provider.getBalance!(avatar, checkedAt.blockNumber))) }; }
        catch (cause) { if (cause instanceof DaoShipsError) throw cause; throw new DaoShipsError('CHAIN_ERROR', 'Unable to read native treasury balance.', {}, { cause }); }
      }
      const balance = await this.read(target, 'balanceOf', [avatar], checkedAt.blockNumber, tokenInterface);
      return { address: target, balance: BigInt(balance[0]) };
    }));
    return { avatar, tokens, checkedAt };
  }

  /** One checked block for supply, holdings, retention and every guild-token balance. */
  async getRagequitQuote(dao: string, account: string, sharesToBurn: bigint, lootToBurn: bigint, tokens: readonly string[]) {
    const target = cyprusAddress(dao), member = cyprusAddress(account);
    uint(sharesToBurn); uint(lootToBurn);
    if (!Array.isArray(tokens) || tokens.length > 20) throw new DaoShipsError('INVALID_ARGUMENT', 'At most 20 explicit withdrawal tokens are supported.');
    const selected = Array.from(tokens, token => address(token));
    const checkedAt = await this.snapshot();
    const [treasury, shares, loot, retention] = await Promise.all([
      this.treasuryAt(target, checkedAt), this.read(target, 'sharesToken', [], checkedAt.blockNumber),
      this.read(target, 'lootToken', [], checkedAt.blockNumber), this.read(target, 'minRetentionPercent', [], checkedAt.blockNumber),
    ]);
    const [sharesSupply, lootSupply, memberShares, memberLoot] = await Promise.all([
      this.read(shares[0], 'totalSupply', [], checkedAt.blockNumber, tokenInterface),
      this.read(loot[0], 'totalSupply', [], checkedAt.blockNumber, tokenInterface),
      this.read(shares[0], 'balanceOf', [member], checkedAt.blockNumber, tokenInterface),
      this.read(loot[0], 'balanceOf', [member], checkedAt.blockNumber, tokenInterface),
    ]);
    const result = quoteRagequit({ sharesSupply: sharesSupply[0], lootSupply: lootSupply[0], memberShares: memberShares[0], memberLoot: memberLoot[0],
      sharesToBurn, lootToBurn, minRetentionBps: retention[0], guildTokens: treasury.tokens, tokens: selected,
      ...(member === treasury.avatar ? { burnFromTreasury: { sharesToken: shares[0], lootToken: loot[0] } } : {}) });
    await this.verifySnapshot(checkedAt);
    return { ...result, dao: target, member, avatar: treasury.avatar, checkedAt };
  }

  /** Simulate an encoded launcher, navigator, token, Poster or custom contract call. */
  async prepareCall(call: Pick<EncodedCall, 'to' | 'data' | 'value'> & { operation?: string }, from: string): Promise<PreparedTransaction> {
    const input = { from: cyprusAddress(from), to: cyprusAddress(call.to), data: hex(call.data),
      value: uint(call.value), operation: call.operation ?? 'contractCall' };
    const block = await this.snapshot();
    return this.simulate(input, block);
  }

  private async simulate(call: Omit<PreparedTransaction, 'chainId' | 'checkedAt'>,
    block: { blockNumber: number; blockHash: string }): Promise<PreparedTransaction> {
    const transaction: PreparedTransaction = { ...call, chainId: this.chainId,
      checkedAt: { blockNumber: block.blockNumber, blockHash: block.blockHash } };
    await callProvider(this.provider, { to: call.to, from: call.from, data: call.data, value: call.value, blockTag: block.blockNumber },
      { timeoutMs: this.timeoutMs, maxResponseBytes: this.maxResponseBytes });
    await this.verifySnapshot(block);
    return transaction;
  }

  private async prepare(dao: string, from: string, operation: PreparedTransaction['operation'],
    args: readonly unknown[], value: bigint, block: { blockNumber: number; blockHash: string }): Promise<PreparedTransaction> {
    return this.simulate({ from: cyprusAddress(from), to: cyprusAddress(dao),
      data: daoInterface.encodeFunctionData(operation, args) as Hex, value: uint(value), operation }, block);
  }

  async prepareVote(dao: string, id: number, approved: boolean, from: string): Promise<PreparedTransaction> {
    if (typeof approved !== 'boolean') throw new DaoShipsError('INVALID_ARGUMENT', 'approved must be a boolean.');
    const block = await this.snapshot();
    const proposal = await this.proposal(dao, id, block);
    if (proposal.state !== ProposalState.Voting) throw new DaoShipsError('PROPOSAL_STATE', 'Proposal is not voting.');
    return this.prepare(dao, from, 'submitVote', [id, approved], 0n, block);
  }

  async prepareSponsor(dao: string, id: number, from: string): Promise<PreparedTransaction> {
    const block = await this.snapshot();
    const proposal = await this.proposal(dao, id, block);
    if (proposal.state !== ProposalState.Submitted) throw new DaoShipsError('PROPOSAL_STATE', 'Proposal is not awaiting sponsorship.');
    return this.prepare(dao, from, 'sponsorProposal', [id], 0n, block);
  }

  /** At most 1000 votes; proposal reads run in batches of eight to bound RPC pressure. */
  async prepareVotes(dao: string, votes: readonly { proposalId: number; approved: boolean }[], from: string): Promise<PreparedTransaction> {
    if (!Array.isArray(votes) || votes.length > 1000) throw new DaoShipsError('INVALID_ARGUMENT', 'Batch preparation supports at most 1000 votes.');
    votes = Array.from({ length: votes.length }, (_, i) => {
      const entry = Object.getOwnPropertyDescriptor(votes, String(i));
      const id = entry && Object.hasOwn(entry, 'value') && entry.value && Object.getOwnPropertyDescriptor(entry.value, 'proposalId');
      const approved = entry && Object.hasOwn(entry, 'value') && entry.value && Object.getOwnPropertyDescriptor(entry.value, 'approved');
      if (!id || !approved || !Object.hasOwn(id, 'value') || !Object.hasOwn(approved, 'value')) throw new DaoShipsError('INVALID_ARGUMENT', 'Votes require dense entries with own proposalId and approved data fields.');
      return { proposalId: id.value as number, approved: approved.value as boolean };
    });
    if (!votes.length || new Set(votes.map(vote => proposalId(vote.proposalId))).size !== votes.length
      || votes.some(vote => typeof vote.approved !== 'boolean')) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Provide a nonempty list of unique proposal IDs and boolean votes.');
    }
    const block = await this.snapshot();
    for (let i = 0; i < votes.length; i += 8) {
      const proposals = await Promise.all(votes.slice(i, i + 8).map(vote => this.proposal(dao, vote.proposalId, block)));
      if (proposals.some(proposal => proposal.state !== ProposalState.Voting)) throw new DaoShipsError('PROPOSAL_STATE', 'Every proposal must be voting.');
    }
    return this.prepare(dao, from, 'submitVotes', [votes.map(vote => vote.proposalId), votes.map(vote => vote.approved)], 0n, block);
  }

  /** Tokens are explicit: omitted guild tokens will not be withdrawn when balances are burned. */
  async prepareRagequit(dao: string, from: string, recipient: string, shares: bigint, loot: bigint,
    tokens: readonly string[]): Promise<PreparedTransaction> {
    if (!Array.isArray(tokens) || tokens.length > 20) throw new DaoShipsError('INVALID_ARGUMENT', 'Ragequit supports at most 20 guild tokens.');
    uint(shares); uint(loot); uint(shares + loot);
    if (shares + loot === 0n || BigInt(address(recipient)) === 0n) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Ragequit requires a nonzero burn and recipient.');
    }
    const sorted = Array.from(tokens, address).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    if (new Set(sorted.map(token => token.toLowerCase())).size !== sorted.length) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Ragequit tokens must be unique.');
    }
    return this.prepare(dao, from, 'ragequit', [address(recipient), shares, loot, sorted], 0n, await this.snapshot());
  }

  async prepareCancel(dao: string, id: number, from: string): Promise<PreparedTransaction> {
    proposalId(id);
    const block = await this.snapshot();
    return this.prepare(address(dao), from, 'cancelProposal', [id], 0n, block);
  }

  async prepareSubmit(dao: string, from: string, data: string, details: string, expiration = 0n): Promise<PreparedTransaction> {
    hex(data); uint(expiration, 40);
    const block = await this.snapshot(true);
    const [shares, threshold, offering, priorVotes] = await Promise.all([
      this.read(dao, 'sharesToken', [], block.blockNumber),
      this.read(dao, 'sponsorThreshold', [], block.blockNumber),
      this.read(dao, 'proposalOffering', [], block.blockNumber),
      this.read(dao, 'getPriorVotes', [address(from), block.timestamp - 1], block.blockNumber),
    ]);
    const supply = (await this.read(shares[0], 'totalSupply', [], block.blockNumber, tokenInterface))[0] as bigint;
    const effectiveThreshold = supply < threshold[0] ? supply : threshold[0] as bigint;
    const value = priorVotes[0] >= effectiveThreshold ? 0n : offering[0] as bigint;
    return this.prepare(dao, from, 'submitProposal', [data, expiration, details], value, block);
  }

  async prepareProcess(dao: string, id: number, from: string, originalData?: string): Promise<PreparedTransaction> {
    const block = await this.snapshot();
    const status = await this.proposal(dao, id, block);
    if (status.processed || (status.state !== ProposalState.Ready && status.state !== ProposalState.Defeated)) {
      throw new DaoShipsError('PROPOSAL_STATE', 'Proposal must be unprocessed and Ready or Defeated.', { state: status.state });
    }
    let data: Hex = '0x';
    if (status.state === ProposalState.Ready) {
      if (originalData === undefined) throw new DaoShipsError('INVALID_ARGUMENT', 'Original proposal data is required.');
      data = hex(originalData);
      const [proposal, retention] = await Promise.all([
        this.read(dao, 'proposals', [id], block.blockNumber),
        this.read(dao, 'minRetentionPercent', [], block.blockNumber),
      ]);
      if (hashProposalData(data).toLowerCase() !== String(proposal.proposalDataHash).toLowerCase()) {
        throw new DaoShipsError('HASH_MISMATCH', 'Proposal bytes do not match the committed hash.');
      }
      if (retention[0] > 0n) {
        const [shares, loot] = await Promise.all([
          this.read(dao, 'sharesToken', [], block.blockNumber), this.read(dao, 'lootToken', [], block.blockNumber),
        ]);
        const [sharesSupply, lootSupply] = await Promise.all([
          this.read(shares[0], 'totalSupply', [], block.blockNumber, tokenInterface),
          this.read(loot[0], 'totalSupply', [], block.blockNumber, tokenInterface),
        ]);
        const current = BigInt(sharesSupply[0]) + BigInt(lootSupply[0]);
        const required = BigInt(proposal.maxTotalSharesAndLootAtVote) * BigInt(retention[0]) / 10000n;
        if (current < required) throw new DaoShipsError('RETENTION_VETO', 'Processing now would permanently defeat this proposal.', { current, required });
      }
    }
    const avatar = (await this.read(dao, 'avatar', [], block.blockNumber))[0] as string;
    const enabled = (await this.read(avatar, 'isModuleEnabled', [address(dao)], block.blockNumber, vaultInterface))[0];
    if (!enabled) throw new DaoShipsError('PROPOSAL_STATE', 'DAOShip is not enabled as a vault module.');
    return this.prepare(dao, from, 'processProposal', [id, data], 0n, block);
  }
}
