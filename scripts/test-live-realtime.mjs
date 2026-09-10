import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectDaoShipsSupabase, DAOSHIPS_SUPABASE, watchIndexer, supabaseRealtimeAdapter } from '../dist/index.js';

/** Workspace acceptance only: manual disconnect suppresses the Supabase client's
 * channel error/rejoin machinery. Close the transport to exercise auto-recovery. */
export function interruptRealtimeTransport(realtime) {
  const socket = realtime?.conn;
  if (!socket || socket.readyState !== 1 || typeof socket.close !== 'function') throw new Error('Expected an open realtime transport.');
  socket.close(4000, 'SDK read-only reconnect acceptance');
  return socket;
}

export async function testLiveRealtime(network) {
  if (!['mainnet', 'testnet'].includes(network)) throw new Error('Select mainnet or testnet explicitly.');
  // Workspace-only acceptance uses the same installed Supabase client as the app.
  // No client dependency is added to the SDK runtime or automatically downloaded.
  const app = process.env.DAOSHIPS_TEST_APP ?? fileURLToPath(new URL('../../daoships-app/', import.meta.url));
  const fromApp = createRequire(resolve(app, 'package.json'));
  const { createClient } = fromApp('@supabase/supabase-js');
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 45_000);
  let client, watch, result, stage = 'connect', changes = 0, subscriptions = 0, snapshots = 0, errors = 0, interruptions = 0;
  const diagnostics = () => ({ changes, subscriptions, snapshots, observedTransportErrors: errors, interruptions,
    channels: client?.getChannels().length ?? 0,
    transportState: ['connecting', 'open', 'closing', 'closed'].includes(client?.realtime.connectionState()) ? client.realtime.connectionState() : 'unknown' });
  async function until(predicate) {
    while (!predicate()) {
      controller.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    const connection = await connectDaoShipsSupabase({ network, signal: controller.signal });
    client = createClient(DAOSHIPS_SUPABASE.url, DAOSHIPS_SUPABASE.publishableKey, {
      db: { schema: connection.schema }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { timeout: 5_000 },
    });
    const bridge = supabaseRealtimeAdapter(client, { schema: connection.schema, table: 'indexer_state', channelName: `sdk-acceptance-${Date.now()}` });
    stage = 'change-delivery';
    watch = await watchIndexer(connection.indexer, 'indexer_state', {
      schema: connection.schema, maxRows: 2, maxPages: 2, timeoutMs: 10_000, signal: controller.signal,
      subscribe: (callbacks, signal) => bridge({ ...callbacks,
        onChange(event) { changes++; callbacks.onChange(event); },
        onReconnect() { subscriptions++; callbacks.onReconnect(); },
      }, signal),
      onSnapshot() { snapshots++; }, onError() { errors++; },
    });
    await until(() => subscriptions >= 1 && changes >= 1 && snapshots >= 2 && !watch.lastError);
    const before = { changes, subscriptions, snapshots };
    stage = 'reconnect';
    const interruptedSocket = interruptRealtimeTransport(client.realtime); interruptions++;
    await until(() => client.realtime.conn !== interruptedSocket && client.realtime.isConnected()
      && subscriptions > before.subscriptions && changes > before.changes && snapshots > before.snapshots && !watch.lastError);
    stage = 'cleanup';
    await watch.close();
    if (client.getChannels().length !== 0) throw new Error('Channel remained after close.');
    result = { status: 'passed', network, ...diagnostics(),
      cleanup: 'no-channels', limitation: 'Observed live checkpoint updates and a forced reconnect; no database writes or reorg was induced.' };
  } catch (error) {
    const code = controller.signal.aborted ? 'TIMEOUT' : /^[A-Z_]{1,50}$/.test(error?.code) ? error.code : 'REALTIME_ACCEPTANCE_FAILED';
    console.error(JSON.stringify({ status: 'failed', stage, code, ...diagnostics() }));
    throw Object.assign(new Error('Read-only realtime acceptance failed.'), { code, reported: true });
  } finally {
    clearTimeout(deadline); controller.abort();
    await watch?.close().catch(() => {});
    try { await client?.removeAllChannels(); }
    finally { client?.realtime.disconnect(); }
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || !['mainnet', 'testnet'].includes(process.argv[2])) { console.error('Select mainnet or testnet explicitly.'); process.exitCode = 1; }
  else await testLiveRealtime(process.argv[2]).catch(error => {
    if (!error.reported) console.error(JSON.stringify({ status: 'failed', stage: 'setup-or-cleanup', code: 'REALTIME_ACCEPTANCE_FAILED' }));
    process.exitCode = 1;
  });
}
