export type ErrorCode =
  | 'INVALID_ARGUMENT' | 'INDEXER_ERROR' | 'INVALID_RESPONSE' | 'TIMEOUT' | 'ABORTED'
  | 'CHAIN_MISMATCH' | 'CHAIN_ERROR' | 'PROPOSAL_STATE' | 'HASH_MISMATCH'
  | 'RETENTION_VETO' | 'TX_REVERTED' | 'MISSING_EVENT' | 'ACTION_FAILED' | 'PROPOSAL_DEFEATED'
  | 'SIGNER_MISMATCH' | 'PLAN_CHANGED' | 'BROADCAST_ERROR' | 'PERSISTENCE_ERROR' | 'TX_PENDING'
  | 'RECOVERY_CONFLICT' | 'RECOVERY_BLOCKED';

/** Stable machine-readable codes; messages are for humans. */
export class DaoShipsError extends Error {
  override readonly name = 'DaoShipsError';
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) { super(message, options); }

  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}
