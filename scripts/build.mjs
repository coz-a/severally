#!/usr/bin/env node
// Bundles the server into one dependency-free file so a plugin can ship it
// without carrying node_modules: dist/peer-consult-mcp.mjs.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The bundle lands inside the plugin so the plugin directory is self-contained.
const outfile = path.join(root, 'plugins', 'peer-consult', 'dist', 'peer-consult-mcp.mjs');

const result = await build({
  entryPoints: [path.join(root, 'bin', 'peer-consult-mcp.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false, // keep it auditable: this file runs with the user's credentials
  // The entry file already carries its own shebang; esbuild preserves it.
  logLevel: 'info',
  metafile: true,
});

fs.chmodSync(outfile, 0o755);
const bytes = fs.statSync(outfile).size;
const inputs = Object.keys(result.metafile.outputs[path.relative(process.cwd(), outfile)]?.inputs ?? {}).length;
console.log(`\nbundled ${inputs} modules -> ${outfile} (${(bytes / 1024).toFixed(0)} KB)`);
