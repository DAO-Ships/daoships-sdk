import type { NavigatorKind } from './navigators-types.js';
import { DaoShipsError } from './errors.js';

export interface NavigatorRequirements {
  /** DAO role needed for the navigator's privileged effects (MANAGER=2, GOVERNOR=4). */
  readonly daoPermission: 0n | 2n | 4n;
  /** Treasury access is a vault module grant, activated through DAO governance rather than a DAO role bit. */
  readonly vaultModule: boolean;
  /** Required for indexed DAO endorsement; does not gate the Signal contract's voting. */
  readonly posterEndorsement: boolean;
}
const manager = Object.freeze({ daoPermission: 2n, vaultModule: false, posterEndorsement: false } as const);
export const NAVIGATOR_REQUIREMENTS: Readonly<Record<NavigatorKind, NavigatorRequirements>> = Object.freeze({
  OnboarderNavigator: manager,
  ERC20TributeNavigator: manager,
  NFTGatedNavigator: manager,
  VestingNavigator: manager,
  SubscriptionNavigator: manager,
  TimelockNavigator: Object.freeze({ daoPermission: 4n, vaultModule: false, posterEndorsement: false } as const),
  BudgetNavigator: Object.freeze({ daoPermission: 0n, vaultModule: true, posterEndorsement: false } as const),
  SignalNavigator: Object.freeze({ daoPermission: 0n, vaultModule: false, posterEndorsement: true } as const),
});

/** Known-kind requirements only: this does not attest bytecode, current grants or readiness. */
export function getNavigatorRequirements(kind: NavigatorKind): NavigatorRequirements {
  if (typeof kind !== 'string' || !Object.hasOwn(NAVIGATOR_REQUIREMENTS, kind)) throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown navigator kind.');
  return NAVIGATOR_REQUIREMENTS[kind];
}
