import assert from 'node:assert/strict';
import { CONTRACT_ABIS, ABI_SOURCE_SHA256 } from '../dist/abis.js';
import { loadAbiSources } from './abi-sources.mjs';

// Development-only parity check. The installed package never imports a sibling checkout.
const { abis, provenance } = await loadAbiSources();
assert.deepEqual(CONTRACT_ABIS, abis);
assert.deepEqual(ABI_SOURCE_SHA256, provenance);
console.log(`All ${Object.keys(abis).length} SDK interfaces match source artifacts and recorded SHA-256 provenance.`);
