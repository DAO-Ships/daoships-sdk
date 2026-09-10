// Workspace acceptance harness, not a product CLI. Default mode performs no I/O beyond imports.
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { JsonRpcProvider } from 'quais';
import { SCENARIOS, validateConfig, readBounded } from './orchard/support.mjs';
import { executeOrchard, inspectOrchard } from './orchard/runner.mjs';

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, plan: { type: 'boolean' }, read: { type: 'boolean' }, execute: { type: 'boolean' },
    config: { type: 'string' }, 'keys-file': { type: 'string' }, evidence: { type: 'string' } }, strict: true });
  if (values.help) { console.log('Orchard acceptance: --plan (offline default), --read --config FILE, or --execute --config FILE --keys-file PRIVATE_ENV --evidence DIRECTORY. See docs/ORCHARD_ACCEPTANCE.md.'); return; }
  if ([values.plan, values.read, values.execute].filter(Boolean).length > 1) throw Error('Choose one acceptance mode.');
  if (!values.execute && values['keys-file']) throw Error('Wallet files are accepted only in explicit execute mode.');
  if (!values.read && !values.execute) {
    console.log(JSON.stringify({ mode: 'plan', chainId: 15000, broadcasts: false, scenarios: SCENARIOS,
      requirements: ['reviewed public config', 'fresh hosted testnet indexer', 'two dedicated funded Cyprus-1 wallets for execute only', 'exclusive durable evidence directory'],
      execution: 'node scripts/orchard-acceptance.mjs --execute --config <reviewed.json> --keys-file <private.env> --evidence <directory>' }, null, 2));
    return;
  }
  if (!values.config) throw Error('A reviewed configuration file is required.');
  const configFile = resolve(values.config), config = validateConfig(JSON.parse(await readBounded(configFile, 65536)));
  if (values.execute) {
    if (!values['keys-file'] || !values.evidence) throw Error('Execution requires an explicit private wallet file and evidence directory.');
    const result = await executeOrchard(config, { keysFile: resolve(values['keys-file']), evidenceDirectory: resolve(values.evidence), configDirectory: dirname(configFile) });
    console.log(JSON.stringify(result, null, 2));
  } else {
    const provider = new JsonRpcProvider(config.rpcUrl, undefined, { usePathing: true });
    try {
      const readiness = await inspectOrchard(config, provider);
      console.log(JSON.stringify({ mode: 'read', chainId: 15000, ready: true, checkedBlock: readiness.discovered.blockNumber,
        indexerSchema: readiness.indexer.schema, indexerAgeMs: readiness.indexer.health.ageMs, broadcasts: false }, null, 2));
    } finally { provider.destroy(); }
  }
}
main().catch(error => {
  // Never print provider errors, arguments, request bodies or wallet material.
  process.stderr.write(JSON.stringify({ status: 'stopped', code: typeof error?.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : 'ACCEPTANCE_FAILED',
    ...(typeof error?.details?.reason === 'string' && /^[A-Z_]{1,40}$/.test(error.details.reason) ? { reason: error.details.reason } : {}),
    guidance: 'Check the documented configuration, readiness requirements and public evidence. No automatic resend is performed.' }) + '\n', () => process.exit(1));
  // The pinned provider may retain a failed transport after destroy(); exit only after
  // main's finally blocks finished and the sanitized error has been flushed.
});
