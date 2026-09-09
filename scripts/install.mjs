#!/usr/bin/env node
// Installs the MCP server globally, registers it with both clients, and places
// the matching skill in each client's user directory.
//
// Existing configuration is preserved: registration goes through each client's
// own `mcp add` command rather than hand-editing its config, and every file it
// touches is backed up first under ~/.peer-consult/backups/<timestamp>/.
//
//   node scripts/install.mjs [--dry-run] [--skip-global] [--force]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const skipGlobal = argv.has('--skip-global');
const force = argv.has('--force');

const home = os.homedir();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(home, '.peer-consult', 'backups', stamp);

const log = (...a) => console.log(...a);
const step = (s) => log(`\n== ${s}`);

function run(cmd, args, opts = {}) {
  const { real, ...spawnOpts } = opts;
  if (dryRun && !real) {
    log(`   [dry-run] ${cmd} ${args.join(' ')}`);
    return '';
  }
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
}

function tryRun(cmd, args, opts) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message) };
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  if (dryRun) { log(`   [dry-run] backup ${file}`); return null; }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, path.basename(file));
  fs.copyFileSync(file, dest);
  return dest;
}

function backupTree(dir) {
  if (!fs.existsSync(dir)) return null;
  if (dryRun) { log(`   [dry-run] backup ${dir}`); return null; }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, path.basename(dir));
  fs.cpSync(dir, dest, { recursive: true });
  return dest;
}

// Read-only probes run even under --dry-run, so the plan it prints is accurate.
function which(bin) {
  const r = tryRun('sh', ['-c', `command -v ${bin}`], { real: true });
  return r.ok ? r.out.trim() : null;
}

// ---------------------------------------------------------------- global install
step('Installing the MCP server globally');
let serverBin = which('peer-consult-mcp');
if (skipGlobal) {
  log('   --skip-global: leaving the global install alone');
} else {
  const r = tryRun('npm', ['install', '-g', root], { cwd: root });
  if (!r.ok) {
    log(`   npm install -g failed:\n${r.out}`);
    process.exitCode = 1;
  } else {
    log('   npm install -g ok');
    if (which('nodenv')) tryRun('nodenv', ['rehash']);
    serverBin = which('peer-consult-mcp') ?? serverBin;
  }
}
if (!serverBin) {
  // Fall back to the checkout so registration still points at something runnable.
  serverBin = path.join(root, 'bin', 'peer-consult-mcp.mjs');
  log(`   ${dryRun ? 'note' : 'WARNING'}: peer-consult-mcp is not on PATH; registering ${serverBin} instead`);
}
log(`   server command: ${serverBin}`);

// ---------------------------------------------------------------- Claude Code
step('Registering with Claude Code (user scope)');
if (!which('claude')) {
  log('   claude CLI not found on PATH — skipped');
} else {
  backup(path.join(home, '.claude.json'));
  const existing = tryRun('claude', ['mcp', 'get', 'peer-consult'], { real: true });
  if (existing.ok && !force) {
    log('   already registered; leaving it as it is (use --force to re-register)');
  } else {
    if (existing.ok) tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'peer-consult']);
    const r = tryRun('claude', ['mcp', 'add', '--scope', 'user', 'peer-consult', '--', serverBin]);
    log(r.ok ? '   registered' : `   failed: ${r.out}`);
    if (!r.ok) process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- Codex
step('Registering with Codex');
if (!which('codex')) {
  log('   codex CLI not found on PATH — skipped');
} else {
  backup(path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml'));
  const existing = tryRun('codex', ['mcp', 'get', 'peer-consult'], { real: true });
  if (existing.ok && !force) {
    log('   already registered; leaving it as it is (use --force to re-register)');
  } else {
    if (existing.ok) tryRun('codex', ['mcp', 'remove', 'peer-consult']);
    const r = tryRun('codex', ['mcp', 'add', 'peer-consult', '--', serverBin]);
    log(r.ok ? '   registered' : `   failed: ${r.out}`);
    if (!r.ok) process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- skills
step('Installing the skills');
const skillTargets = [
  { from: path.join(root, 'skills', 'claude-code', 'peer-consult'), to: path.join(home, '.claude', 'skills', 'peer-consult'), label: 'Claude Code (consults Codex)' },
  { from: path.join(root, 'skills', 'codex', 'peer-consult'), to: path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'skills', 'peer-consult'), label: 'Codex (consults Claude Code)' },
];
for (const { from, to, label } of skillTargets) {
  const parent = path.dirname(to);
  if (!fs.existsSync(parent) && !dryRun) fs.mkdirSync(parent, { recursive: true });
  const saved = backupTree(to);
  if (saved) log(`   backed up the existing ${label} skill to ${saved}`);
  if (dryRun) { log(`   [dry-run] copy ${from} -> ${to}`); continue; }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  log(`   ${label}: ${to}`);
}

// ---------------------------------------------------------------- summary
step('Done');
if (fs.existsSync(backupDir)) log(`   backups: ${backupDir}`);
log(`
Verify with:
  claude mcp get peer-consult
  codex mcp get peer-consult
  node ${path.join(root, 'scripts', 'live-check.mjs')} --target claude-code

In a new Claude Code session the tools appear as mcp__peer-consult__consult_start / _get / _cancel / _list.
Restart any running client session to pick the server up.`);
