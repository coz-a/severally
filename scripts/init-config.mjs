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

// Documentation as a flat list of strings, kept apart from the settings by its
// shape as much as its position: an example written as a nested object looks
// exactly like a live setting, which is what made the earlier template hard to
// read. The server reads only `targets`.
/**
 * The config template for this machine, as JSONC: the server strips comments
 * before parsing, so the documentation can be documentation instead of fake
 * data dressed up as settings.
 */
export function renderConfig() {
  const lines = [
    '{',
    '  // peer-consult configuration. Comments and trailing commas are allowed.',
    '  // Precedence, per key: environment variable > this file > autodetection > built-in default.',
    '  // Read once at server start -- restart the client after editing.',
    '  //',
    '  // Per target, all optional:',
    '  //   enabled          false to exclude a consultant whose CLI is installed -- e.g. a rate-limited account',
    '  //   note             why it is off; returned to whoever asks for that consultant',
    '  //   bin              a CLI that is not on PATH, a specific build, or a wrapper script (~/ is expanded)',
    '  //   default_model    the model this consultant runs unless a request names another',
    '  //   allowed_models   the models a request MAY name; the default above is always allowed',
    '  "targets": {',
  ];
  TARGETS.forEach((id, i) => {
    const t = POLICY.targets[id];
    const comma = i === TARGETS.length - 1 ? '' : ',';
    // Only what is true of this target here; the keys are documented once, above.
    lines.push(
      `    // ${isInstalled(t.cli) ? `${t.cli} found, default model ${t.model}` : `${t.cli} not found -- excluded automatically`}`,
      `    ${JSON.stringify(id)}: {}${comma}`,
    );
  });
  lines.push('  }', '}', '');
  return lines.join('\n');
}

/** Where the server would look for this file, given the same environment. */
export function configPath(env = process.env) {
  if (env.PEER_CONSULT_CONFIG) return env.PEER_CONSULT_CONFIG;
  const home = env.PEER_CONSULT_HOME || path.join(os.homedir(), '.peer-consult');
  // The server reads config.jsonc in preference to config.json, so an existing
  // .jsonc is the file to leave alone -- writing .json beside it would produce
  // a config that looks authoritative and is silently ignored.
  const jsonc = path.join(home, 'config.jsonc');
  return fs.existsSync(jsonc) ? jsonc : path.join(home, 'config.json');
}

function main() {
  const argv = new Set(process.argv.slice(2));
  const body = renderConfig();

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
  console.log('per target: enabled  note  bin  default_model  allowed_models');
  console.log('   e.g.  "codex": { "enabled": false, "note": "rate-limited until 15:00" }');
  console.log('   more: config.example.json, README §4.5. Restart the client after editing.');
  console.log('   comments and trailing commas are fine; name it config.jsonc if your editor prefers that');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
