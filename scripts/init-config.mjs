#!/usr/bin/env node
// Writes a starting ~/.severally/config.json for THIS machine: what it
// detected, what the defaults currently are, and the shape of each key.
//
//   node scripts/init-config.mjs            # write, refusing to clobber
//   node scripts/init-config.mjs --print    # stdout only, write nothing
//   node scripts/init-config.mjs --force    # replace an existing file
//
// A machine that simply lacks a CLI needs no config at all -- the server
// detects that at startup. The generated file writes out the consultants the
// server would make without one (one per CLI, on its default model), so the
// operator has the shape to copy when adding a second one on a CLI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY, isInstalled } from '../src/policy.mjs';
import { CLI_IDS, DEFAULT_MODELS } from '../src/consultants.mjs';

// Documentation as a flat list of strings, kept apart from the settings by its
// shape as much as its position: an example written as a nested object looks
// exactly like a live setting, which is what made the earlier template hard to
// read. The server reads only `server`, `clis`, `consultants` and `ranking`.
/**
 * The config template for this machine, as JSONC: the server strips comments
 * before parsing, so the documentation can be documentation instead of fake
 * data dressed up as settings.
 */
export function renderConfig() {
  const lines = [
    '{',
    '  // severally configuration. Comments and trailing commas are allowed.',
    '  // Read once at server start -- restart the client after editing. A mistake in this file stops every',
    '  // consultation (the reason is in each refusal) rather than running on defaults.',
    '  //',
    '  // clis: per CLI, all optional',
    '  //   enabled          false to exclude a CLI that is installed -- e.g. a rate-limited account',
    '  //   note             why it is off; returned to whoever asks for one of its consultants',
    '  //   bin              a CLI that is not on PATH, a specific build, or a wrapper script (~/ is expanded)',
    '  //   args             extra CLI arguments, e.g. ["--disallowedTools", "WebFetch"]; isolation flags are refused',
    '  //   env              extra environment variables, e.g. {"HTTPS_PROXY": "..."}; isolation variables are refused',
    '  //',
    '  // consultants: name -> one CLI running one model. Add several on one CLI to ask them apart,',
    '  // e.g. "deepseek": { "cli": "opencode", "model": "opencode/deepseek-v4.1-flash-free" }',
    '  // Preserve existing entries: an explicit consultants object replaces the defaults. For another model,',
    '  // run opencode models, add an operator-named entry, restart, then check status. Detection is not a live test.',
    '  // Store no API key in a consultant entry; compatible provider setup and env references are in CONFIG.md.',
    '  //   cli, model       required',
    '  //   effort           reasoning effort (default high); antigravity takes it from the model name instead',
    "  //   timeout_ms       this consultant's own budget in ms (default: server timeout_ms, max 7200000)",
    '  //   max_budget_usd   claude-code only: spending cap per consultation (default 10, 0.05-20)',
    "  //   fallback_model   a model to run instead, once, when model's quota is used up (usage_limit)",
    '  //   vendor           the lineage, when the model name does not say (e.g. "nvidia")',
    '  //   enabled, note    as for clis, for this consultant alone',
    '  //',
    '  // ranking: optional, higher first -- which consultant a name that fits several goes to,',
    '  // before the built-in rules (opus over sonnet, newer version). e.g. "ranking": ["sol", "opus"]',
    '  //',
    '  // server: optional -- max_rounds (5, 1-20), max_concurrent (9, 1-9), timeout_ms (1800000),',
    '  //   max_wait_ms (45000), max_jobs_retained, kill_grace_ms: see CONFIG.md',
    '  "clis": {},',
    '  "consultants": {',
  ];
  CLI_IDS.forEach((id, i) => {
    const bin = POLICY.clis[id].cli;
    const comma = i === CLI_IDS.length - 1 ? '' : ',';
    // Only what is true of this CLI here; the keys are documented once, above.
    lines.push(
      `    // ${isInstalled(bin) ? `${bin} found` : `${bin} not found -- unavailable until it is installed`}`,
      `    ${JSON.stringify(id)}: { "cli": ${JSON.stringify(id)}, "model": ${JSON.stringify(DEFAULT_MODELS[id])} }${comma}`,
    );
  });
  lines.push('  }', '}', '');
  return lines.join('\n');
}

/** Where the server would look for this file, given the same environment. */
export function configPath(env = process.env) {
  if (env.SEVERALLY_CONFIG) return env.SEVERALLY_CONFIG;
  const home = env.SEVERALLY_HOME || path.join(os.homedir(), '.severally');
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
      `severally: ${target} already exists; not overwriting it.\n` +
        '  --force to replace it, or --print to see the template without writing.\n',
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, body, { mode: 0o600 });

  // What the machine has belongs here rather than in the file: it is a fact
  // about right now, and the server re-detects it every time it starts.
  console.log(`wrote ${target}`);
  for (const id of CLI_IDS) {
    const bin = POLICY.clis[id].cli;
    console.log(
      isInstalled(bin)
        ? `   ${id.padEnd(12)} ${bin} found, consultant "${id}" on ${DEFAULT_MODELS[id]}`
        : `   ${id.padEnd(12)} ${bin} not found -- unavailable until it is installed`,
    );
  }
  console.log('');
  console.log('clis.<cli>: enabled  note  bin  args  env');
  console.log('consultants.<name>: cli  model  effort  timeout_ms  max_budget_usd  fallback_model  vendor  enabled  note');
  console.log('   more: CONFIG.md (what each key does), config.example.json (a working example).');
  console.log('   Restart the client after editing.');
  console.log('   comments and trailing commas are fine; name it config.jsonc if your editor prefers that');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
