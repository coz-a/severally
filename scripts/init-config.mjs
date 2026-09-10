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

const README = [
  'peer-consult, per-machine configuration. Every key is optional.',
  'Precedence, knob by knob: environment variable > this file > autodetection > built-in default.',
  'Keys starting with "_" are notes: the server ignores them, so you can leave them in place.',
  'To use a suggestion, move the key out of its "_example" block into the target itself.',
  'This file is read once, when the MCP server starts -- restart the client after editing it.',
].join(' ');

/** The config template for the machine this runs on. */
export function renderConfig(env = process.env) {
  const targets = {};
  for (const id of TARGETS) {
    const t = POLICY.targets[id];
    const cli = t.cli;
    const found = isInstalled(cli);
    targets[id] = {
      _detected: found
        ? `"${cli}" is runnable here, so this consultant is offered by default`
        : `"${cli}" was not found, so this consultant is not offered -- no config needed to exclude it`,
      _defaults: { bin: cli, model: t.model },
      _example: found
        ? {
          _enabled: 'set false to exclude this consultant even though its CLI is installed'
            + ' -- e.g. an account you know is rate-limited or out of quota',
          enabled: false,
          _note: 'shown to the caller when it asks for a consultant that is off, so say why',
          note: 'rate-limited on this account',
          _models: 'models a request may name, on top of the default (which is always allowed)',
          models: [t.model],
        }
        : {
          _enabled: 'set true only if you also give a "bin" this machine can actually run',
          enabled: true,
          bin: cli,
          models: [t.model],
        },
    };
  }
  return {
    _readme: README,
    _generated: new Date().toISOString(),
    _host: os.hostname(),
    targets,
  };
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

  const offered = TARGETS.filter((id) => isInstalled(POLICY.targets[id].cli));
  const absent = TARGETS.filter((id) => !offered.includes(id));
  console.log(`wrote ${target}`);
  console.log(`   detected: ${offered.length ? offered.join(', ') : '(no consultant CLI on PATH)'}`);
  if (absent.length) console.log(`   not found: ${absent.join(', ')} -- excluded automatically, no config needed`);
  console.log('   restart the client for a change here to take effect');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
