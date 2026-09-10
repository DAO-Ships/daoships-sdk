import { parseContractEvents } from './events.js';
import { DaoShipsError } from './errors.js';
import { proposalId } from './values.js';

export interface Receipt {
  /** Present on native quais receipts; checked when confirming a submitted hash. */
  hash?: string;
  status: number | null;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
}

function matchingEvents<E extends 'SubmitProposal' | 'ProcessProposal'>(receipt: Receipt, dao: string, name: E) {
  return parseContractEvents(receipt, 'DAOShip', dao, name);
}

export function parseSubmitReceipt(receipt: Receipt, dao: string): number {
  const events = matchingEvents(receipt, dao, 'SubmitProposal');
  if (events.length !== 1) throw new DaoShipsError('MISSING_EVENT', 'Expected exactly one SubmitProposal event from this DAO.');
  return proposalId(Number(events[0]!.args.proposal));
}

export type ProcessOutcome = 'executed' | 'defeated' | 'action_failed';
export function parseProcessReceipt(receipt: Receipt, dao: string, id: number): ProcessOutcome {
  proposalId(id);
  const events = matchingEvents(receipt, dao, 'ProcessProposal').filter(event => event.args.proposal === BigInt(id));
  if (events.length !== 1) throw new DaoShipsError('MISSING_EVENT', 'Expected exactly one ProcessProposal event for this DAO and proposal.');
  const event = events[0]!;
  if (!event.args.passed) return 'defeated';
  return event.args.actionFailed ? 'action_failed' : 'executed';
}

/** Use for an intended execution; closing a defeated proposal legitimately returns 'defeated'. */
export function assertActionSucceeded(receipt: Receipt, dao: string, id: number): void {
  const outcome = parseProcessReceipt(receipt, dao, id);
  if (outcome === 'defeated') throw new DaoShipsError('PROPOSAL_DEFEATED', 'Proposal was processed without passing.');
  if (outcome === 'action_failed') throw new DaoShipsError('ACTION_FAILED', 'Proposal passed but its action reverted.');
}
