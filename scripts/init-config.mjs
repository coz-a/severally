#!/usr/bin/env node
// Writes a starting ~/.peer-consult/config.json for THIS machine: what it
// detected, what the defaults currently are, and the shape of each key.
//
//   node scripts/init-config.mjs            # write, refusing to clobber
//   node scripts/init-config.mjs --print    # stdout only, write nothing
//   node scripts/init-config.mjs --force    # replace an existing file
//
// Every key the template suggests is optional. A machine that simply lacks a
// CLI needs no config at all -- the server detects that at startup -- so the
// generated file leads with what was detected and keeps the editable keys in
// `_example` blocks, which the loader ignores until you move them up.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, POLICY, isInstalled } from '../src/policy.mjs';

/**
 * The config template for the machine this runs on: the structure, and nothing
 * else. Guidance belongs on the terminal and in the README -- mixing prose keys
 * into the file makes the handful of real settings hard to pick out.
 */
export function renderConfig() {
  const targets = {};
  for (const id of TARGETS) targets[id] = {};
  return { targets };
}

/** Where the server would look for this file, given the same environment. */
export function configPath(env = process.env) {
  return env.PEER_CONSULT_CONFIG
    || path.join(env.PEER_CONSULT_HOME || path.join(os.homedir(), '.peer-consult'), 'config.json');
}

function main() {
  const argv = new Set(process.argv.slice(2));
  const body = `${JSON.stringify(renderConfig(), null, 2)}\n`;

  if (argv.has('--print')) {
    process.stdout.write(body);
    return;
  }

  const target = configPath();
  if (fs.existsSync(target) && !argv.has('--force')) {
    process.stderr.write(
      `peer-consult: ${target} already exists; not overwriting it.\n`
      + '  --force to replace it, or --print to see the template without writing.\n',
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, body, { mode: 0o600 });

  // What the machine has belongs here rather than in the file: it is a fact
  // about right now, and the server re-detects it every time it starts.
  console.log(`wrote ${target}`);
  for (const id of TARGETS) {
    const t = POLICY.targets[id];
    console.log(isInstalled(t.cli)
      ? `   ${id.padEnd(12)} ${t.cli} found, default model ${t.model}`
      : `   ${id.padEnd(12)} ${t.cli} not found -- excluded automatically, no config needed`);
  }
  console.log('');
  console.log('per target: enabled (true/false)  note (why it is off)  bin (path)  model (id)  models (list)');
  console.log('   e.g.  "codex": { "enabled": false, "note": "rate-limited until 15:00" }');
  console.log('   more: config.example.json, README §4.5. Restart the client after editing.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
