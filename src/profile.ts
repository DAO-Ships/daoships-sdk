import { DaoShipsError } from './errors.js';
import { address } from './values.js';
import { buildPosterContent, POSTER_TAGS, type DaoProfileMetadata, type DaoProfileUpdateMetadata } from './poster.js';

type Fields = Omit<DaoProfileMetadata, 'daoAddress'>;
/** Field state assembled from DAO columns plus the latest profile record. Null means absent. */
export type DaoProfileState = { [K in keyof Fields]?: Fields[K] | null };
/** Omitted/undefined fields preserve current values; null clears; nested objects replace the whole field. */
export type DaoProfilePatch = DaoProfileState;
const MATERIALIZED = ['name', 'description', 'avatar'] as const;
const RECORD_ONLY = ['banner', 'theme', 'links', 'tags', 'chainId'] as const;
const FIELD_NAMES = new Set<string>([...MATERIALIZED, ...RECORD_ONLY]);

function readFields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'DAO profile fields must be a plain record.');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > FIELD_NAMES.size) throw new DaoShipsError('INVALID_ARGUMENT', 'Too many DAO profile fields.');
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== 'string' || !FIELD_NAMES.has(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'DAO profile contains an unknown field or unsupported property.');
    }
    if (descriptor.value !== undefined) entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}
function validatedFields(daoAddress: string, fields: Record<string, unknown>): Record<string, unknown> {
  const values = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
  const normalized = JSON.parse(buildPosterContent(POSTER_TAGS.DAO_PROFILE, { daoAddress, ...values })) as Record<string, unknown>;
  delete normalized.daoAddress;
  delete normalized.schemaVersion;
  return normalized;
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]
    && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * Plan an unsigned DAO profile update without losing latest-record-only metadata.
 * The caller must provide complete current state (DAO columns plus latest record).
 * Returns null for no change, otherwise a validated, detached DAO_PROFILE payload.
 * This does not read chain/indexer state or authorize who may publish the update.
 */
export function buildDaoProfileUpdate(dao: string, current: DaoProfileState, patch: DaoProfilePatch): DaoProfileUpdateMetadata | null {
  try {
    const daoAddress = address(dao);
    const before = validatedFields(daoAddress, readFields(current));
    const patchFields = readFields(patch);
    const replacements = validatedFields(daoAddress, patchFields);
    const next = { ...before, ...replacements };
    for (const [key, value] of Object.entries(patchFields)) if (value === null) delete next[key];
    if (sameValue(before, next)) return null;
    const payload: Record<string, unknown> = { daoAddress };
    // These three fields merge into ds_daos; explicit null is the supported clear sentinel.
    for (const key of MATERIALIZED) if (!sameValue(before[key], next[key])) payload[key] = next[key] ?? null;
    // Other profile fields exist only in the latest ds_records content_json. Omitting a
    // cleared field removes it; every remaining field must be carried into the new record.
    for (const key of RECORD_ONLY) if (Object.hasOwn(next, key)) payload[key] = next[key];
    const result = JSON.parse(buildPosterContent(POSTER_TAGS.DAO_PROFILE, payload as unknown as DaoProfileUpdateMetadata)) as DaoProfileUpdateMetadata & { schemaVersion?: string };
    delete result.schemaVersion;
    return result;
  } catch (cause) {
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid DAO profile update input.', {}, { cause });
  }
}
