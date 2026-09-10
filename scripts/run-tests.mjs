// Import into one node:test process so every assertion is visible, including in
// environments that prohibit child processes. No forced exit hides open handles.
import { readdir } from 'node:fs/promises';

const directory = new URL('../test/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
if (!files.length) throw new Error('No SDK tests found.');
for (const file of files) await import(new URL(file, directory));
