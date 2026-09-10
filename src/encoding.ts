import { AbiCoder, Interface, concat, keccak256, toBeHex } from 'quais';
import { address, hex, uint, type Hex } from './values.js';
import { DaoShipsError } from './errors.js';

const coder = AbiCoder.defaultAbiCoder();
const multiSend = new Interface(['function multiSend(bytes transactions)']);
const governance = new Interface(['function executeAsGovernance(address to,uint256 value,bytes data)']);

/** A CALL from the vault. MultiSendCallOnly does not permit delegatecall actions. */
export interface ProposalAction { to: string; value: bigint; data: string }
export interface DecodedProposalAction extends ProposalAction { operation: 0 }
export interface ProposalCodecOptions {
  /** Maximum number of actions, default 1,000. */
  maxActions?: number;
  /** Maximum total encoded proposal bytes, default 1 MiB. */
  maxBytes?: number;
}

function limits(options: ProposalCodecOptions) {
  if (!options || typeof options !== 'object') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected proposal codec options.');
  const maxActions = options.maxActions ?? 1000, maxBytes = options.maxBytes ?? 1_048_576;
  if (![maxActions, maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal action and byte limits must be positive safe integers.');
  }
  return { maxActions, maxBytes };
}
function boundedBytes(data: string, maxBytes: number): Hex {
  if (typeof data !== 'string' || data.length > maxBytes * 2 + 2) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal exceeds the encoded byte limit.');
  }
  return hex(data);
}
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected proposal action data.');
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property || !Object.hasOwn(property, 'value')) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal inputs must be dense own data properties without accessors.');
  }
  return property.value;
}

export function encodeProposal(actions: readonly ProposalAction[], options: ProposalCodecOptions = {}): Hex {
  try {
    const { maxActions, maxBytes } = limits(options);
    if (!Array.isArray(actions)) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a proposal action array.');
    const count = actions.length;
    if (count === 0 || count > maxActions) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Provide a nonempty proposal action array within the action limit.');
    }
    let packedBytes = 0;
    const packed: string[] = [];
    for (let index = 0; index < count; index++) {
      const action = ownData(actions, String(index));
      const target = ownData(action, 'to');
      if (typeof target !== 'string') throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal target must be an address string.');
      const to = address(target);
      const value = uint(ownData(action, 'value') as bigint);
      const data = boundedBytes(ownData(action, 'data') as string, maxBytes);
      packedBytes += 85 + (data.length - 2) / 2;
      // selector + offset + byte length + the right-padded packed transaction body.
      if (68 + Math.ceil(packedBytes / 32) * 32 > maxBytes) {
        throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal exceeds the encoded byte limit.');
      }
      packed.push(concat(['0x00', to, toBeHex(value, 32), toBeHex((data.length - 2) / 2, 32), data]));
    }
    return multiSend.encodeFunctionData('multiSend', [concat(packed)]) as Hex;
  } catch (cause) {
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid proposal action input.', {}, { cause });
  }
}

/**
 * Decode complete canonical MultiSendCallOnly bytes. Reject malformed/truncated
 * input and unsupported operations instead of returning a partial action list.
 * Empty `0x` is the protocol's valid empty proposal. This does not authenticate
 * targets, interpret inner calldata, or prove that any action will succeed.
 */
export function decodeProposal(data: string, options: ProposalCodecOptions = {}): DecodedProposalAction[] {
  try {
    const { maxActions, maxBytes } = limits(options);
    const encoded = boundedBytes(data, maxBytes);
    if (encoded === '0x') return [];
    const packed = multiSend.decodeFunctionData('multiSend', encoded)[0] as string;
    if (multiSend.encodeFunctionData('multiSend', [packed]).toLowerCase() !== encoded.toLowerCase()) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal must contain canonical complete multiSend(bytes) calldata.');
    }
    const body = packed.slice(2);
    const actions: DecodedProposalAction[] = [];
    let offset = 0;
    while (offset < body.length) {
      if (actions.length >= maxActions) throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal exceeds the action limit.');
      if (body.length - offset < 170) throw new DaoShipsError('INVALID_ARGUMENT', 'Truncated MultiSend action header.');
      const operation = Number.parseInt(body.slice(offset, offset + 2), 16);
      if (operation !== 0) throw new DaoShipsError('INVALID_ARGUMENT', 'MultiSendCallOnly requires CALL operation zero.', { action: actions.length, operation });
      const to = address(`0x${body.slice(offset + 2, offset + 42)}`);
      const value = BigInt(`0x${body.slice(offset + 42, offset + 106)}`);
      const length = BigInt(`0x${body.slice(offset + 106, offset + 170)}`);
      offset += 170;
      // Compare as bigint before converting an attacker-controlled uint256 length.
      if (length > BigInt((body.length - offset) / 2)) throw new DaoShipsError('INVALID_ARGUMENT', 'Truncated MultiSend action calldata.');
      const end = offset + Number(length) * 2;
      actions.push({ operation: 0, to, value, data: `0x${body.slice(offset, end)}` });
      offset = end;
    }
    return actions;
  } catch (cause) {
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid MultiSend proposal calldata.', {}, { cause });
  }
}

/** Match DAOShip.hashOperation: keccak256(abi.encode(bytes)), not keccak256(bytes). */
export function hashProposalData(data: string): Hex {
  return keccak256(coder.encode(['bytes'], [hex(data)])) as Hex;
}

/** Compare bytes to a caller-supplied commitment; obtain that commitment from a trusted chain read. */
export function verifyProposalDataHash(data: string, expectedHash: string, options: Pick<ProposalCodecOptions, 'maxBytes'> = {}): boolean {
  const { maxBytes } = limits(options);
  if (typeof expectedHash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(expectedHash)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a 32-byte proposal commitment hash.');
  }
  return hashProposalData(boundedBytes(data, maxBytes)).toLowerCase() === expectedHash.toLowerCase();
}

/** Wrap governance-protected DAO calls (minting, config, permissions) as a vault action. */
export function governanceAction(dao: string, data: string): ProposalAction {
  const to = address(dao);
  return { to, value: 0n, data: governance.encodeFunctionData('executeAsGovernance', [to, 0n, hex(data)]) };
}
