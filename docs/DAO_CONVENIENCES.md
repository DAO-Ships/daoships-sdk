# DAO convenience workflows

These helpers expose economic consequences and unsigned token calls. The application still chooses the action, authorizes signing and handles its receipt.

## Ragequit previews

```ts
const quote = await chain.getRagequitQuote(
  daoAddress, memberAddress, sharesToBurn, lootToBurn, selectedGuildTokens,
);
// quote.withdrawals: exact raw-unit payouts in Solidity token order.
// quote.omittedTokens: registered assets forfeited for the units being burned.
// quote.minimumRemainingSupply / maxBurnable: current DAO retention floor.
// quote.checkedAt: block number/hash used for every read.
const prepared = await chain.prepareRagequit(
  daoAddress, memberAddress, recipientAddress, sharesToBurn, lootToBurn,
  quote.withdrawals.map(row => row.token),
);
```

`getRagequitQuote` reads shares/loot supply, member holdings, retention, the full guild-token list and vault balances at one block, then rechecks the block hash and chain. Selecting no tokens explicitly previews burning without receiving treasury assets. Zero address identifies native QUAI. `quoteRagequit` is the pure counterpart for already captured balances.

When the withdrawing member is the vault itself, burning its shares or loot changes the balances available for withdrawal before the contract calculates payouts. The chain helper automatically subtracts those burns when shares or loot are registered guild assets. Pure callers specify `burnFromTreasury: { sharesToken, lootToken }` for this case; registered balances must match the member's holdings. Each withdrawal includes `balanceBeforeBurn` for the captured holdings and `balance` for the payout calculation. Native QUAI and other assets keep their captured balances.

Arithmetic reproduces checked uint256 multiplication and Solidity's integer division. Insufficient holdings, duplicate/unregistered selected assets, an exceeded retention floor, or intermediate overflow fail explicitly. A quote reports dust when every selected payout rounds to zero. It does not prove that an external token transfers correctly, that the vault still authorizes the DAO, or that balances remain unchanged before mining. Refreshed ragequit preparation and receipt checks remain required.

## Allowance plans and permit discovery

```ts
import {
  readTokenApprovalPlan, probeTokenPermit, buildExternalPermitTypedData,
} from '@daoships/sdk';

const approval = await readTokenApprovalPlan(provider, {
  token: tributeToken, owner: memberAddress, spender: navigatorAddress,
  requiredAllowance: tributeAmount,
}, { blockTag: checkedBlockNumber });

// approval.steps contains no calls when allowance already suffices.
// Otherwise: reset a nonzero allowance to zero, then approve the exact amount.
// Refresh allowance and simulate each step before requesting its signature.
// approval.revoke is an explicit approve(spender, 0) call for later cleanup.

const probe = await probeTokenPermit(provider, tributeToken, memberAddress, {
  chainId: 15000n, blockTag: checkedBlockNumber,
  versionCandidates: ['1'], timeoutMs: 15_000,
});
if (probe.supported) {
  const typed = buildExternalPermitTypedData(probe, {
    spender: navigatorAddress, value: tributeAmount, deadline,
  });
  // Pass typed.domain/types/value to the caller-owned signer. Simulate the
  // signed permit/onboardWithPermit call before broadcasting it.
}
```

`buildTokenApprovalPlan` accepts a supplied current allowance for offline use. `requiredAllowance` is a minimum: an already sufficient larger allowance is left in place. Use the explicit revoke call to remove it. The default zero reset supports tokens that reject nonzero-to-nonzero approvals; `resetPolicy: 'never'` is an explicit opt-out. Approval can still race with a spender consuming an existing allowance; these calls cannot provide atomic spending policy across multiple transactions.

Permit probing reads the nonce and `DOMAIN_SEPARATOR` at the requested fixed block. It uses EIP-5267 domain disclosure when available, otherwise token name/version reads and explicit version candidates. Every candidate must reproduce the token's actual separator. Transport errors, malformed responses, timeouts and chain changes remain errors; they do not silently become “permit unsupported.” Reads have deadlines, cancellation and response byte limits.

A successful probe establishes a domain suitable for standard EIP-2612 typed data, not the existence or exact implementation of `permit`. DAI-style permits, salted domains and extension domains are unsupported. A token can expose compatible reads while implementing a different signature schema or rejecting execution. Validate a signed call by simulation; use the approval plan when the token genuinely lacks a supported permit flow. Historical calls pin a block number but the probe alone does not check its canonical hash; use a trusted captured block and recheck it in the surrounding preparation workflow.

Offline regression tests cover arithmetic boundaries, input mutation, domain mismatches, resource bounds and chain changes. The optional Solidity suite compares quotes with actual native/ERC20 ragequit payouts and executes a discovered external-token permit with replay rejection, zero-reset approvals and revocation.
