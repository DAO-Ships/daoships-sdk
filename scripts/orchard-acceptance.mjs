// Workspace acceptance harness, not a product CLI. Default mode performs no I/O beyond imports.
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchardProvider } from './orchard/provider.mjs';
import { SCENARIOS, validateConfig, readBounded } from './orchard/support.mjs';
import { executeOrchard, inspectOrchard } from './orchard/runner.mjs';
import { executeOrchardSmoke } from './orchard/smoke.mjs';

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, plan: { type: 'boolean' }, read: { type: 'boolean' }, smoke: { type: 'boolean' }, execute: { type: 'boolean' },
    config: { type: 'string' }, 'keys-file': { type: 'string' }, 'env-file': { type: 'string' }, evidence: { type: 'string' } }, strict: true });
  if (values.help) { console.log('Orchard acceptance: --plan (offline default), --read (no wallet), --smoke (one zero-value self-transfer; ORCHARD_PRIVATE_KEY in .env), or --execute --config FILE --evidence DIRECTORY (full suite; two wallets). Optional: --env-file FILE, --config FILE, --evidence DIRECTORY. See docs/ORCHARD_ACCEPTANCE.md.'); return; }
  if ([values.plan, values.read, values.smoke, values.execute].filter(Boolean).length > 1) throw Error('Choose one acceptance mode.');
  if (values['keys-file'] && values['env-file']) throw Error('Choose --env-file or its --keys-file alias.');
  const walletFile = values['env-file'] ?? values['keys-file'];
  if (!values.execute && !values.smoke && walletFile) throw Error('Wallet files are accepted only in explicit transaction modes.');
  if (!values.read && !values.execute && !values.smoke) {
    console.log(JSON.stringify({ mode: 'plan', chainId: 15000, broadcasts: false, scenarios: SCENARIOS,
      smoke: { command: 'npm run test:orchard:smoke', wallets: 1, maxTransactions: 1, value: '0', scenarios: ['readiness', 'stale-plan rejection', 'signer refusal', 'self-transfer with lost acknowledgement and recovery'] },
      requirements: ['reviewed public config for full execute', 'fresh hosted testnet indexer', 'two funded Cyprus-1 wallets for full execute', 'exclusive durable evidence directory'],
      execution: 'node scripts/orchard-acceptance.mjs --execute --config <reviewed.json> --keys-file <private.env> --evidence <directory>' }, null, 2));
    return;
  }
  const configFile = values.config ? resolve(values.config) : fileURLToPath(new URL('./orchard/config.example.json', import.meta.url));
  const config = validateConfig(JSON.parse(await readBounded(configFile, 65536)), { requireReview: !!values.execute });
  const keysFile = walletFile ? resolve(walletFile) : undefined;
  if (values.smoke) {
    console.log(JSON.stringify(await executeOrchardSmoke(config, { keysFile, ...(values.evidence ? { evidenceDirectory: resolve(values.evidence) } : {}) }), null, 2));
  } else if (values.execute) {
    if (!values.evidence) throw Error('Full execution requires an explicit evidence directory.');
    const result = await executeOrchard(config, { keysFile, evidenceDirectory: resolve(values.evidence), configDirectory: dirname(configFile) });
    console.log(JSON.stringify(result, null, 2));
  } else {
    const provider = new OrchardProvider(config.rpcUrl, undefined, { usePathing: true });
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
    guidance: 'See docs/ORCHARD_ACCEPTANCE.md. For smoke, set ORCHARD_PRIVATE_KEY in .env; full execute also needs ORCHARD_MEMBER_PRIVATE_KEY and a reviewed config. Resume with the same evidence directory; no automatic resend is performed.' }) + '\n', () => process.exit(1));
  // The pinned provider may retain a failed transport after destroy(); exit only after
  // main's finally blocks finished and the sanitized error has been flushed.
});
