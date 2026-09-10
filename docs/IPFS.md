# IPFS reads

Contract resources use `https://ipfs.qu.ai`; metadata, allowlists and other content use
`https://ipfs.io`. Every helper accepts an explicit `gateway` override. No gateway
fallback, pinning credentials or Supabase key is forwarded.

```ts
import { fetchIpfsAbi, fetchIpfsBytecode, fetchIpfsJson, resolveIpfsUrl } from '@daoships/sdk';

const metadata = await fetchIpfsJson({ resource: metadataCid });
const abi = await fetchIpfsAbi({ resource: contractMetadataCid });
const creation = await fetchIpfsBytecode({
  resource: bytecodeCid,
  expectedKeccak256: reviewedCreationCodeHash,
});
const imageUrl = resolveIpfsUrl(`ipfs://${imageCid}/avatar.png`);
```

`fetchIpfsAbi` accepts an ABI array, an artifact's `abi`, or Solidity metadata's
`output.abi`. ABI fragments, nesting and response sizes are bounded before parsing
with quais. `fetchIpfsBytecode` accepts a UTF-8 hex document and requires an independently
trusted keccak256 hash of the decoded bytes. It does not select or execute downloaded code.

JSON/ABI results explicitly report `integrity: 'unverified-gateway'` unless the caller
provides `expectedSha256`, a trusted SHA-256 of the **raw response bytes**. This digest is
not interchangeable with a dag-pb CID digest. Successful HTTPS retrieval and syntactically
valid CIDs do not establish complete IPFS DAG verification. Allowlist reads additionally
verify against the caller's on-chain Merkle root; see [data integrations](DATA_INTEGRATIONS.md).

The default response limit is 2 MiB (configurable up to 16 MiB). Reads, body streaming,
hashing and parsing share the timeout and cancellation policy. Redirects, credentials,
unsafe paths, mutable IPNS names and unsupported CID codecs are rejected. Supported CIDs
are CIDv0 SHA-256 dag-pb and lowercase base32 CIDv1 SHA-256 raw/dag-pb. For images and other
non-JSON content, `resolveIpfsUrl` builds the content URL; the consuming application owns
its download, rendering and content validation policy.

## Live acceptance

Create a JSON file containing `abiResource` and `contentResource`, optionally
`abiSha256` and `contentSha256`, then run:

```sh
npm run test:ipfs:live -- /path/to/public-ipfs-fixtures.json
```

This bounded read-only command checks both configured default gateways and fails on
unavailable resources. No credentials, writes, pinning or fallback gateways are used.

On 2026-09-10, current Onboarder metadata was retrieved successfully through `ipfs.qu.ai`.
The `ipfs.io` content request returned HTTP 429 with `Retry-After: 900`. Its linked
[public gateway notice](https://gatewaychanges.ipfs.io/) announces increasing interruptions
and retirement on September 21, 2026. The requested default remains in place pending the
maintainer's replacement choice; consumers can already set a gateway override. A stable
replacement is required before relying on the default for a public release.
