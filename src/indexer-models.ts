/** Public read models from daoships-indexer/supabase/migrations/schema.sql.
 * All SQL BIGINT and NUMERIC values are decimal strings, including timestamps.
 * SQL nullability is preserved. JSON fields and metadata are untrusted data.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type IndexerFieldKind = 'string' | 'integer' | 'boolean' | 'amount' | 'string[]' | 'amount[]' | 'json'
  | 'string?' | 'integer?' | 'boolean?' | 'amount?' | 'string[]?' | 'amount[]?' | 'json?';
export type IndexerShape = Readonly<Record<string, IndexerFieldKind>>;
type FieldValue<K extends IndexerFieldKind> = K extends `${infer Base}?`
  ? FieldValue<Extract<Base, IndexerFieldKind>> | null
  : K extends 'integer' ? number : K extends 'boolean' ? boolean
  : K extends 'string[]' | 'amount[]' ? string[] : K extends 'json' ? JsonValue : string;
export type IndexerProjection<S extends IndexerShape> = { -readonly [K in keyof S]: FieldValue<S[K]> };

/** Opt-in additive migration fields; baseline reads work before migration. */
export const indexerRecordOrderingShape = Object.freeze({ transaction_index: 'integer?', log_index: 'integer?' } as const);
export type OrderedRecordRow = IndexerTables['records'] & IndexerProjection<typeof indexerRecordOrderingShape>;

export const indexerShapes = {
  daos: {
    id: 'string',
    created_at: 'string',
    tx_hash: 'string',
    loot_address: 'string',
    shares_address: 'string',
    avatar: 'string',
    deployer: 'string?',
    launcher_contract: 'string',
    loot_paused: 'boolean?',
    shares_paused: 'boolean?',
    grace_period: 'amount',
    voting_period: 'amount',
    voting_plus_grace_duration: 'amount?',
    proposal_offering: 'amount',
    quorum_percent: 'amount',
    sponsor_threshold: 'amount',
    min_retention_percent: 'amount',
    default_expiry_window: 'amount?',
    share_token_name: 'string?',
    share_token_symbol: 'string?',
    loot_token_name: 'string?',
    loot_token_symbol: 'string?',
    total_shares: 'amount?',
    total_loot: 'amount?',
    latest_sponsored_proposal_id: 'amount?',
    proposal_count: 'amount?',
    active_member_count: 'amount?',
    new_vault: 'boolean?',
    admin_locked: 'boolean?',
    manager_locked: 'boolean?',
    governor_locked: 'boolean?',
    name: 'string?',
    description: 'string?',
    avatar_img: 'string?',
    profile_source: 'string?',
    updated_at: 'string?',
  },
  members: {
    id: 'string',
    dao_id: 'string',
    member_address: 'string',
    created_at: 'string',
    shares: 'amount?',
    loot: 'amount?',
    delegating_to: 'string?',
    voting_power: 'amount?',
    votes: 'amount?',
    last_activity_at: 'string?',
    updated_at: 'string?',
  },
  proposals: {
    id: 'string',
    dao_id: 'string',
    proposal_id: 'amount',
    created_at: 'string',
    submitter: 'string?',
    tx_hash: 'string',
    proposal_data_hash: 'string',
    proposal_data: 'string?',
    details: 'string?',
    prev_proposal_id: 'amount?',
    sponsored: 'boolean?',
    sponsor: 'string?',
    sponsor_tx_hash: 'string?',
    sponsor_tx_at: 'string?',
    self_sponsored: 'boolean?',
    voting_period: 'amount',
    voting_starts: 'string?',
    voting_ends: 'string?',
    grace_ends: 'string?',
    expiration: 'string?',
    cancelled: 'boolean?',
    cancelled_tx_hash: 'string?',
    cancelled_tx_at: 'string?',
    cancelled_by: 'string?',
    processed: 'boolean?',
    process_tx_hash: 'string?',
    process_tx_at: 'string?',
    processed_by: 'string?',
    action_failed: 'boolean?',
    passed: 'boolean?',
    yes_votes: 'amount?',
    no_votes: 'amount?',
    yes_balance: 'amount?',
    no_balance: 'amount?',
    max_total_shares_and_loot_at_vote: 'amount?',
    max_total_shares_at_sponsor: 'amount?',
    proposal_offering: 'amount?',
    block_number: 'amount?',
  },
  votes: {
    id: 'string',
    dao_id: 'string',
    proposal_id: 'string',
    voter: 'string',
    approved: 'boolean',
    balance: 'amount',
    created_at: 'string',
    tx_hash: 'string',
    block_number: 'amount?',
  },
  navigators: {
    id: 'string',
    dao_id: 'string?',
    navigator_address: 'string',
    deployer: 'string?',
    created_at: 'string',
    deploy_block: 'amount?',
    permission: 'integer',
    permission_label: 'string',
    permission_ever_granted: 'boolean',
    trust_status: 'string',
    is_active: 'boolean?',
    paused: 'boolean?',
    navigator_type: 'string?',
    name: 'string?',
    description: 'string?',
    config: 'json?',
    allowlist_root: 'string?',
    tx_hash: 'string',
    updated_at: 'string?',
  },
  ragequits: {
    id: 'string',
    dao_id: 'string',
    member_address: 'string',
    to_address: 'string',
    shares_burned: 'amount',
    loot_burned: 'amount',
    tokens: 'string[]',
    amounts: 'string[]?',
    created_at: 'string',
    tx_hash: 'string',
    block_number: 'amount?',
  },
  records: {
    id: 'string',
    dao_id: 'string?',
    created_at: 'string',
    user_address: 'string',
    tx_hash: 'string',
    tag: 'string',
    content_type: 'string?',
    content: 'string',
    content_json: 'json?',
    trust_level: 'string?',
    block_number: 'amount?',
  },
  guild_tokens: {
    id: 'string',
    dao_id: 'string',
    token_address: 'string',
    enabled: 'boolean?',
    created_at: 'string',
    tx_hash: 'string',
  },
  event_transactions: {
    id: 'string',
    dao_id: 'string?',
    created_at: 'string',
    block_number: 'amount',
  },
  delegations: {
    id: 'integer',
    dao_id: 'string',
    delegator: 'string',
    from_delegate: 'string?',
    to_delegate: 'string',
    created_at: 'string',
    tx_hash: 'string',
  },
  navigator_events: {
    id: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    event_type: 'string',
    contributor: 'string',
    shares_minted: 'amount?',
    loot_minted: 'amount?',
    amount: 'amount?',
    metadata: 'json?',
    created_at: 'string',
    tx_hash: 'string',
    block_number: 'amount',
  },
  nft_claims: {
    id: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    token_id: 'amount',
    holder: 'string',
    shares: 'amount?',
    loot: 'amount?',
    created_at: 'string',
    tx_hash: 'string',
    block_number: 'amount',
  },
  signal_polls: {
    id: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    poll_id: 'amount',
    creator: 'string',
    question: 'string?',
    option_count: 'integer',
    snapshot_timestamp: 'amount',
    voting_starts: 'amount',
    voting_ends: 'amount',
    cancelled: 'boolean?',
    tally: 'amount[]?',
    options: 'string[]?',
    description: 'string?',
    discussion_url: 'string?',
    labels_updated_at: 'string?',
    labels_block_number: 'amount?',
    created_at: 'string',
    tx_hash: 'string',
    block_number: 'amount',
    updated_at: 'string?',
  },
  signal_votes: {
    id: 'string',
    poll_pk: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    poll_id: 'amount',
    voter: 'string',
    option: 'integer',
    weight: 'amount',
    created_at: 'string',
    tx_hash: 'string',
    block_number: 'amount',
  },
  timelock_changes: {
    id: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    change_id: 'amount',
    queued_by: 'string',
    config_hash: 'string',
    governance_config: 'string?',
    executable_after: 'amount',
    expires_at: 'amount',
    status: 'string',
    executed_tx: 'string?',
    cancelled_tx: 'string?',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
    updated_at: 'string?',
  },
  vesting_schedules: {
    id: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    schedule_id: 'amount',
    beneficiary: 'string',
    total_amount: 'amount',
    claimed: 'amount',
    is_loot: 'boolean',
    start_time: 'amount',
    cliff_end: 'amount',
    vesting_end: 'amount',
    revoked: 'boolean',
    revoked_at: 'amount?',
    vested_at_revoke: 'amount?',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
    updated_at: 'string?',
  },
  vesting_claims: {
    id: 'string',
    schedule_pk: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    schedule_id: 'amount',
    beneficiary: 'string',
    amount: 'amount',
    is_loot: 'boolean',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
  },
  budgets: {
    id: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    budget_id: 'amount',
    manager: 'string',
    token: 'string',
    allowance_per_period: 'amount',
    total_ceiling: 'amount',
    total_spent: 'amount',
    period_length: 'amount',
    starts_at: 'amount',
    ends_at: 'amount',
    cancelled: 'boolean',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
    updated_at: 'string?',
  },
  budget_disbursements: {
    id: 'string',
    budget_pk: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    budget_id: 'amount',
    recipient: 'string',
    token: 'string',
    amount: 'amount',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
  },
  subscription_members: {
    id: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    member: 'string',
    paid_through: 'amount',
    total_paid: 'amount',
    last_collected_at: 'string?',
    tx_hash: 'string',
    created_at: 'string',
    updated_at: 'string?',
  },
  subscription_payments: {
    id: 'string',
    member_pk: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    member: 'string',
    payer: 'string',
    token: 'string',
    amount: 'amount',
    periods: 'amount',
    paid_through: 'amount',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
  },
  subscription_collections: {
    id: 'string',
    member_pk: 'string',
    dao_id: 'string',
    navigator_address: 'string',
    member: 'string',
    collector: 'string',
    shares_removed: 'amount',
    reward: 'amount',
    burned: 'boolean',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
  },
  vault_module_events: {
    id: 'string',
    dao_id: 'string',
    vault: 'string',
    navigator_address: 'string',
    enabled: 'boolean',
    tx_hash: 'string',
    log_index: 'integer',
    block_number: 'amount',
    created_at: 'string',
  },
  governance_config_history: {
    id: 'string',
    dao_id: 'string',
    voting_period: 'amount',
    grace_period: 'amount',
    proposal_offering: 'amount',
    quorum_percent: 'amount',
    sponsor_threshold: 'amount',
    min_retention_percent: 'amount',
    default_expiry_window: 'amount',
    bypassed_timelock: 'boolean',
    tx_hash: 'string',
    block_number: 'amount',
    created_at: 'string',
    updated_at: 'string?',
  },
  indexer_state: {
    id: 'integer',
    last_block_number: 'amount',
    last_block_hash: 'string?',
    last_indexed_at: 'string?',
    chain_id: 'integer',
    is_syncing: 'boolean',
    requires_full_reindex: 'boolean',
    reindex_reason: 'string?',
    reindex_flagged_at: 'string?',
  },
} as const satisfies Record<string, IndexerShape>;

// These exported descriptors are part of the input-validation boundary, including
// the table/column allowlist. TypeScript readonly alone does not protect JS callers.
for (const shape of Object.values(indexerShapes)) Object.freeze(shape);
Object.freeze(indexerShapes);

export type IndexerTable = keyof typeof indexerShapes;
export type IndexerTables = { [K in IndexerTable]: IndexerProjection<(typeof indexerShapes)[K]> };
type SchemaFor<K extends IndexerTable> = (typeof indexerShapes)[K];
/** Equality filters are restricted to scalar schema columns. Amounts accept bigint as input. */
export type IndexerFilters<K extends IndexerTable> = {
  [F in keyof SchemaFor<K> as SchemaFor<K>[F] extends 'json' | 'json?' | 'string[]' | 'string[]?' | 'amount[]' | 'amount[]?' ? never : F]?:
    FieldValue<Extract<SchemaFor<K>[F], IndexerFieldKind>> | (SchemaFor<K>[F] extends 'amount' | 'amount?' ? bigint : never)
};
type ScalarCondition<K extends IndexerTable> = {
  [F in keyof IndexerFilters<K>]-?: { column: F; operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: NonNullable<IndexerFilters<K>[F]> }
    | { column: F; operator: 'in'; value: readonly NonNullable<IndexerFilters<K>[F]>[] }
    | (SchemaFor<K>[F & keyof SchemaFor<K>] extends 'string' | 'string?' ? { column: F; operator: 'ilike'; value: string } : never)
    | (null extends IndexerFilters<K>[F] ? { column: F; operator: 'is' | 'not.is'; value: null } : never)
}[keyof IndexerFilters<K>];
type JsonColumn<K extends IndexerTable> = { [F in keyof SchemaFor<K>]: SchemaFor<K>[F] extends 'json' | 'json?' ? F : never }[keyof SchemaFor<K>];
export type IndexerJsonScalar = string | bigint | number | boolean;
/** JSON paths extract text with ->>; paths are bounded identifier segments, not raw SQL. */
type JsonCondition<K extends IndexerTable> = { column: JsonColumn<K>; path: readonly string[] } & (
  { operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: IndexerJsonScalar }
  | { operator: 'in'; value: readonly IndexerJsonScalar[] }
  | { operator: 'ilike'; value: string }
  | { operator: 'is' | 'not.is'; value: null }
);
export type IndexerCondition<K extends IndexerTable> = ScalarCondition<K> | JsonCondition<K>;
/** Nested AND/OR groups; all filters and top-level where entries remain ANDed. */
export type IndexerExpression<K extends IndexerTable> = IndexerCondition<K>
  | { all: readonly IndexerExpression<K>[] }
  | { any: readonly IndexerExpression<K>[] };
export type DaoDetails = IndexerTables['daos'];
export type ProposalDetails = IndexerTables['proposals'];
export type MemberDetails = IndexerTables['members'];
export type IndexerStateDetails = IndexerTables['indexer_state'];
export type VoteRow = IndexerTables['votes'];
export type NavigatorRow = IndexerTables['navigators'];
export type RagequitRow = IndexerTables['ragequits'];
export type RecordRow = IndexerTables['records'];
export type GuildTokenRow = IndexerTables['guild_tokens'];
export type EventTransactionRow = IndexerTables['event_transactions'];
export type DelegationRow = IndexerTables['delegations'];
export type NavigatorEventRow = IndexerTables['navigator_events'];
export type NftClaimRow = IndexerTables['nft_claims'];
export type SignalPollRow = IndexerTables['signal_polls'];
export type SignalVoteRow = IndexerTables['signal_votes'];
export type TimelockChangeRow = IndexerTables['timelock_changes'];
export type VestingScheduleRow = IndexerTables['vesting_schedules'];
export type VestingClaimRow = IndexerTables['vesting_claims'];
export type BudgetRow = IndexerTables['budgets'];
export type BudgetDisbursementRow = IndexerTables['budget_disbursements'];
export type SubscriptionMemberRow = IndexerTables['subscription_members'];
export type SubscriptionPaymentRow = IndexerTables['subscription_payments'];
export type SubscriptionCollectionRow = IndexerTables['subscription_collections'];
export type VaultModuleEventRow = IndexerTables['vault_module_events'];
export type GovernanceConfigHistoryRow = IndexerTables['governance_config_history'];
