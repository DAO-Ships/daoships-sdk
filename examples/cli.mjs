#!/usr/bin/env node
// A consumer smoke test for the SDK; the future CLI can replace argument handling.
import { FetchRequest, JsonRpcProvider } from 'quais';
import { DaoShipsChain, DaoShipsIndexer, DaoShipsError, stringify } from '@daoships/sdk';

const usage = `Usage: node examples/cli.mjs <command> [arguments]
  daos [offset] [limit]
  proposals <dao> [offset] [limit]
  members <dao> [offset] [limit]
  indexer-state
  proposal-state <dao> <proposal-id>
  prepare-vote <dao> <proposal-id> <from> <yes|no>
  prepare-process <dao> <proposal-id> <from> [original-data]

Indexer: DAOSHIPS_INDEXER_URL, DAOSHIPS_INDEXER_KEY, DAOSHIPS_INDEXER_SCHEMA
Chain:   DAOSHIPS_RPC_URL (including /cyprus1), DAOSHIPS_CHAIN_ID
Results are JSON on stdout; errors are JSON on stderr with exit code 1.
Preparation prints unsigned data. It does not broadcast a transaction.`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new DaoShipsError('INVALID_ARGUMENT', `${name} is required.`);
  return value;
}
function page(offset, limit) { return { offset: Number(offset ?? 0), limit: Number(limit ?? 50) }; }

let provider;
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log(usage);
  } else if (['daos', 'proposals', 'members', 'indexer-state'].includes(command)) {
    const client = new DaoShipsIndexer({ url: required('DAOSHIPS_INDEXER_URL'), key: required('DAOSHIPS_INDEXER_KEY'),
      schema: required('DAOSHIPS_INDEXER_SCHEMA') });
    let result;
    if (command === 'daos') result = await client.listDaos(page(args[0], args[1]));
    if (command === 'proposals') result = await client.listProposals(args[0], page(args[1], args[2]));
    if (command === 'members') result = await client.listMembers(args[0], page(args[1], args[2]));
    if (command === 'indexer-state') result = await client.getState();
    console.log(stringify(result, 2));
  } else if (['proposal-state', 'prepare-vote', 'prepare-process'].includes(command)) {
    const request = new FetchRequest(required('DAOSHIPS_RPC_URL'));
    request.timeout = 15_000;
    // A complete shard endpoint is supplied, so do not append shard paths again.
    provider = new JsonRpcProvider(request, undefined, { usePathing: false });
    const client = new DaoShipsChain(provider, Number(required('DAOSHIPS_CHAIN_ID')));
    const [dao, rawId, from, option] = args;
    const id = Number(rawId);
    let result;
    if (command === 'proposal-state') result = await client.getProposal(dao, id);
    if (command === 'prepare-process') result = await client.prepareProcess(dao, id, from, option);
    if (command === 'prepare-vote') {
      if (!['yes', 'no'].includes(option)) throw new DaoShipsError('INVALID_ARGUMENT', 'Vote must be yes or no.');
      result = await client.prepareVote(dao, id, option === 'yes', from);
    }
    console.log(stringify(result, 2));
  } else {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown command; use --help.');
  }
} catch (error) {
  console.error(stringify({ error: error instanceof DaoShipsError ? error : { code: 'UNEXPECTED', message: 'Command failed.' } }));
  process.exitCode = 1;
} finally {
  provider?.destroy();
}
