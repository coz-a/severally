#!/usr/bin/env node
// Installs peer-consult into both clients.
//
// Two modes:
//   plugin (default) - installs plugins/peer-consult as a plugin in each client:
//                      Claude Code picks it up from ~/.claude/skills/peer-consult
//                      (skills-dir plugin, no marketplace); Codex installs it
//                      from the repo-local marketplace in .agents/plugins.
//   --manual         - the older path: register the MCP server with each
//                      client's `mcp add` and copy the two skills by hand.
//
// Either way the global npm install happens: Codex can only launch a plugin MCP
// server by bare executable name from PATH (verified: contained "./" paths and
// ${PLUGIN_ROOT} substitution do not work in codex 0.153.4).
//
// Existing configuration is preserved: client config is changed through each
// client's own CLI rather than hand-edited, and every file this touches is
// backed up first under ~/.peer-consult/backups/<timestamp>/.
//
//   node scripts/install.mjs [--dry-run] [--manual] [--skip-global] [--force]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(root, 'plugins', 'peer-consult');
const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const skipGlobal = argv.has('--skip-global');
const force = argv.has('--force');
const mode = argv.has('--manual') ? 'manual' : 'plugin';

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

// Backup names are derived from the whole path: two different clients both
// hold a "peer-consult" directory, and one must not overwrite the other.
function backupName(target) {
  return path
    .relative(home, target)
    .replace(/^\.\.[\\/]/, 'abs/')
    .replace(/[\\/]/g, '_')
    .replace(/^\./, '');
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  if (dryRun) { log(`   [dry-run] backup ${file}`); return null; }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, backupName(file));
  fs.copyFileSync(file, dest);
  return dest;
}

function backupTree(dir) {
  if (!fs.existsSync(dir)) return null;
  if (dryRun) { log(`   [dry-run] backup ${dir}`); return null; }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, backupName(dir));
  fs.cpSync(dir, dest, { recursive: true });
  return dest;
}

// Read-only probes run even under --dry-run, so the plan it prints is accurate.
function which(bin) {
  const r = tryRun('sh', ['-c', `command -v ${bin}`], { real: true });
  return r.ok ? r.out.trim() : null;
}

// ---------------------------------------------------------------- global install
step(`Installing the MCP server globally (mode: ${mode})`);
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

const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
const claudeSkillsDir = path.join(home, '.claude', 'skills');

if (mode === 'plugin') {
  // ------------------------------------------------------------- plugin mode
  step('Installing the plugin into Claude Code (skills-dir plugin, no marketplace)');
  const target = path.join(claudeSkillsDir, 'peer-consult');
  const saved = backupTree(target);
  if (saved) log(`   backed up the existing ${target} to ${saved}`);
  if (dryRun) {
    log(`   [dry-run] copy ${PLUGIN} -> ${target}`);
  } else {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(PLUGIN, target, { recursive: true });
    log(`   installed: ${target} (loads as peer-consult@skills-dir)`);
  }
  // A user-scope MCP registration would duplicate the one the plugin provides.
  if (which('claude')) {
    const dup = tryRun('claude', ['mcp', 'get', 'peer-consult'], { real: true });
    if (dup.ok) {
      backup(path.join(home, '.claude.json'));
      const r = tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'peer-consult']);
      log(r.ok ? '   removed the duplicate user-scope MCP registration' : `   could not remove the duplicate registration: ${r.out}`);
    }
  }

  step('Installing the plugin into Codex (repo-local marketplace)');
  if (!which('codex')) {
    log('   codex CLI not found on PATH — skipped');
  } else {
    backup(path.join(codexHome, 'config.toml'));
    const marketplace = 'peer-consult-local';
    const known = tryRun('codex', ['plugin', 'marketplace', 'list'], { real: true });
    if (!known.out.includes(marketplace)) {
      const r = tryRun('codex', ['plugin', 'marketplace', 'add', root]);
      log(r.ok ? `   marketplace added: ${marketplace} -> ${root}` : `   marketplace add failed: ${r.out}`);
    } else {
      log(`   marketplace ${marketplace} already configured`);
    }
    tryRun('codex', ['plugin', 'remove', 'peer-consult', '--marketplace', marketplace]);
    const r = tryRun('codex', ['plugin', 'add', `peer-consult@${marketplace}`]);
    log(r.ok ? '   plugin installed' : `   plugin install failed: ${r.out}`);
    if (!r.ok) process.exitCode = 1;
    // Same duplication concern on the Codex side.
    const dup = tryRun('codex', ['mcp', 'get', 'peer-consult'], { real: true });
    if (dup.ok) {
      const rm = tryRun('codex', ['mcp', 'remove', 'peer-consult']);
      log(rm.ok ? '   removed the duplicate global MCP registration' : `   could not remove the duplicate registration: ${rm.out}`);
    }
    const strayCodexSkill = path.join(codexHome, 'skills', 'peer-consult');
    if (fs.existsSync(strayCodexSkill)) {
      const s2 = backupTree(strayCodexSkill);
      if (!dryRun) fs.rmSync(strayCodexSkill, { recursive: true, force: true });
      log(`   removed the hand-copied skill (the plugin supplies it); backup: ${s2}`);
    }
  }
} else {
  // ------------------------------------------------------------- manual mode
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

  step('Registering with Codex');
  if (!which('codex')) {
    log('   codex CLI not found on PATH — skipped');
  } else {
    backup(path.join(codexHome, 'config.toml'));
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

  step('Installing the skills');
  const skillTargets = [
    { from: path.join(PLUGIN, 'skills', 'claude', 'peer-consult'), to: path.join(claudeSkillsDir, 'peer-consult'), label: 'Claude Code (consults Codex)' },
    { from: path.join(PLUGIN, 'skills', 'codex', 'peer-consult'), to: path.join(codexHome, 'skills', 'peer-consult'), label: 'Codex (consults Claude Code)' },
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
}

// ---------------------------------------------------------------- summary
step('Done');
if (fs.existsSync(backupDir)) log(`   backups: ${backupDir}`);
log(mode === 'plugin' ? `
Verify with:
  claude plugin details peer-consult
  codex plugin list
  node ${path.join(root, 'scripts', 'live-check.mjs')} --target claude-code

Restart any running client session to pick the plugin up. In Claude Code the tools then appear as
mcp__plugin_peer-consult_peer-consult__consult_start / _get / _cancel / _list.

Re-run this after "npm run build" to push an updated plugin to both clients.` : `
Verify with:
  claude mcp get peer-consult
  codex mcp get peer-consult
  node ${path.join(root, 'scripts', 'live-check.mjs')} --target claude-code

In a new Claude Code session the tools appear as mcp__peer-consult__consult_start / _get / _cancel / _list.
Restart any running client session to pick the server up.`);
