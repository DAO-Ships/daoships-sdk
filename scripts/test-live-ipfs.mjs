import { readFile } from 'node:fs/promises';
import { fetchIpfsAbi, fetchIpfsJson } from '../dist/ipfs.js';

// Exact, caller-selected immutable resources. Never substitutes another gateway.
const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error('Provide an IPFS acceptance JSON file with abiResource and contentResource.');
const source = await readFile(file, 'utf8');
if (source.length > 16384) throw new Error('IPFS acceptance configuration is too large.');
const config = JSON.parse(source);
if (typeof config.abiResource !== 'string' || typeof config.contentResource !== 'string') throw new Error('Both contract and content resources are required.');
let stage = 'abi', abiReport;
try {
  const abi = await fetchIpfsAbi({ resource: config.abiResource, timeoutMs: 15000,
    ...(config.abiSha256 ? { expectedSha256: config.abiSha256 } : {}),
  });
  abiReport = { abiFragments: abi.abi.length, abiIntegrity: abi.integrity };
  stage = 'content';
  const content = await fetchIpfsJson({ resource: config.contentResource, timeoutMs: 15000,
    ...(config.contentSha256 ? { expectedSha256: config.contentSha256 } : {}),
  });
  console.log(JSON.stringify({ status: 'passed', abiGateway: 'ipfs.qu.ai', contentGateway: 'ipfs.io',
    abiFragments: abi.abi.length, abiIntegrity: abi.integrity, contentIntegrity: content.integrity,
    limitation: 'Gateway availability and supplied-resource checks only; no pinning or complete DAG verification.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, code: error.code ?? 'IPFS_ACCEPTANCE_FAILED', httpStatus: error.details?.status, abi: abiReport }));
  process.exitCode = 1;
}
