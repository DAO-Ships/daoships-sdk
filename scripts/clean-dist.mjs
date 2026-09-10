import { rm } from 'node:fs/promises';

// Only compiler output is disposable. Resolve from this script, never caller cwd.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
