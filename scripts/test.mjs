// Expand test files ourselves: Windows shells and older Node versions do not
// expand the glob passed by `node --test test/*.test.mjs`.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = fs.readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `test/${name}`);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files],
  { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
