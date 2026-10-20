#!/usr/bin/env node
// Installs severally into all four clients: Claude Code, Codex, Antigravity,
// OpenCode.
//
// Two modes:
//   plugin (default) - installs plugins/severally as a plugin in Claude Code
//                      (~/.claude/skills/severally, skills-dir plugin, no
//                      marketplace) and in Codex (a copied local marketplace
//                      under ~/.severally/marketplace). Antigravity has no verified
//                      plugin-install path yet, and OpenCode has no plugin
//                      mechanism at all, so both are registered directly
//                      in both modes: `agy mcp add` / `opencode mcp add`
//                      plus a skill copy, same as --manual mode below.
//   --manual         - (default on Windows) register the MCP server with each client's own `mcp
//                      add` (`agy mcp add` for Antigravity) and copy each
//                      client's skill by hand.
//
// In plugin mode the global npm install happens unless --skip-global is set:
// Codex can only launch a plugin MCP
// server by bare executable name from PATH (verified: contained "./" paths and
// ${PLUGIN_ROOT} substitution do not work in codex 0.153.4).
// All platforms copy the bundle into ~/.severally/runtime. Plugin mode also
// copies its marketplace into ~/.severally/marketplace; no installed path
// points back to this checkout.
//
// Existing configuration is preserved: client config is changed through each
// client's own CLI rather than hand-edited, and every file this touches is
// backed up first under ~/.severally/backups/<timestamp>/.
//
// When the global npm install cannot be made (npm needs sudo, or npm's global
// folder is not on PATH), plugin mode registers Codex directly instead, so the
// install still finishes.
//
//   node scripts/install.mjs [--dry-run] [--manual] [--skip-global] [--force] [--allow-local-tools]

import { copyTree, execCommandSync, findCommand } from '../src/platform.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(
    `severally-install: Node.js 22 or newer is needed (this is ${process.versions.node}); update Node.js and run it again`,
  );
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(root, 'plugins', 'severally');
const FLAGS = ['--dry-run', '--manual', '--skip-global', '--force', '--allow-local-tools'];
const argv = new Set(process.argv.slice(2));
// A word the installer does not know is refused before anything changes: a
// shell that passes a pasted "# add --dry-run ..." comment on as arguments
// would otherwise turn an install into a silent dry run.
const unknownArgs = [...argv].filter((a) => !FLAGS.includes(a));
if (unknownArgs.length) {
  console.error(
    `severally-install: unknown argument(s) ${unknownArgs.map((a) => JSON.stringify(a)).join(' ')}; it takes ${FLAGS.join(' ')}`,
  );
  process.exit(2);
}
const dryRun = argv.has('--dry-run');
const skipGlobal = argv.has('--skip-global');
const force = argv.has('--force');
// Native Windows clients cannot all launch npm .cmd shims as MCP servers.
// Direct registration uses node.exe plus an absolute script path instead.
const mode = argv.has('--manual') || process.platform === 'win32' ? 'manual' : 'plugin';

const home = os.homedir();
// opencode resolves its global paths through xdg-basedir: XDG_CONFIG_HOME, when
// set, decides where opencode.json and its skills live. The installer must read
// and write the same place the CLI resolves, or it would back up and edit a
// file opencode never looks at. The other clients keep their own conventions
// (~/.claude, ~/.codex/CODEX_HOME, ~/.gemini), which no XDG variable redirects.
const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(home, '.severally', 'backups', stamp);
let keptRegistrations = false;
let lastListOutput = '';

/** @param {...unknown} a */
const log = (...a) => console.log(...a);
/** @param {string} s */
const step = (s) => log(`\n== ${s}`);

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('../src/platform.mjs').ExecOptions & { real?: boolean }} [opts]
 */
function run(cmd, args, opts = {}) {
  const { real, ...spawnOpts } = opts;
  if (dryRun && !real) {
    log(`   [dry-run] ${cmd} ${args.join(' ')}`);
    return '';
  }
  return execCommandSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('../src/platform.mjs').ExecOptions & { real?: boolean }} [opts]
 * @returns {RunResult}
 */
function tryRun(cmd, args, opts) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (e) {
    const err = /** @type {{ stdout?: unknown, stderr?: unknown, message?: unknown }} */ (e);
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message) };
  }
}

// Backup names are derived from the whole path: two different clients both
// hold a "severally" directory, and one must not overwrite the other.
/** @param {string} target */
function backupName(target) {
  return path
    .relative(home, target)
    .replace(/^\.\.[\\/]/, 'abs/')
    .replace(/[\\/]/g, '_')
    .replace(/^\./, '');
}

/** @param {string} file */
function backup(file) {
  if (!fs.existsSync(file)) return null;
  if (dryRun) {
    log(`   [dry-run] backup ${file}`);
    return null;
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, backupName(file));
  // Several client operations can touch the same config in one install.
  // Keep the first snapshot, before any of those operations changed it.
  if (fs.existsSync(dest)) return dest;
  fs.copyFileSync(file, dest);
  return dest;
}

/** @param {string} dir */
function backupTree(dir) {
  if (!fs.existsSync(dir)) return null;
  if (dryRun) {
    log(`   [dry-run] backup ${dir}`);
    return null;
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, backupName(dir));
  copyTree(dir, dest);
  return dest;
}

// Read-only probes run even under --dry-run, so the plan it prints is accurate.
/** @param {string} bin */
function which(bin) {
  return findCommand(bin);
}

// The severally-mcp a client will launch by name. npm puts node_modules/.bin
// folders first on PATH for what it runs (npx's cache, and the current folder
// and every parent): a client never sees those, and one may hold an older
// severally-mcp package, so they are not where the command is looked for.
function runtimeCommand() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = (process.env[key] ?? '')
    .split(path.delimiter)
    .filter((dir) => !/(^|[\\/])node_modules[\\/]\.bin[\\/]?$/.test(dir.replace(/^"(.*)"$/, '$1')));
  return findCommand('severally-mcp', { env: { ...process.env, [key]: dirs.join(path.delimiter) } });
}

// ---------------------------------------------------------------- server install
function installRuntime() {
  const source = path.join(PLUGIN, 'dist', 'severally-mcp.mjs');
  const installed = path.join(home, '.severally', 'runtime', 'severally-mcp.mjs');
  if (!fs.existsSync(source)) throw new Error(`Missing server bundle: ${source}. Run npm run build first.`);
  if (dryRun) {
    backup(installed);
    log(`   [dry-run] copy ${source} -> ${installed}`);
    return installed;
  }
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  // Validate a staged copy before replacing the working runtime. The bundle
  // contains its dependencies, so it needs neither the checkout nor npm.
  const stagedDir = fs.mkdtempSync(path.join(path.dirname(installed), '.install-'));
  const staged = path.join(stagedDir, 'severally-mcp.mjs');
  try {
    fs.copyFileSync(source, staged);
    run(process.execPath, ['--check', staged], { real: true });
    // The bundle carries other packages' code, so their licences travel with
    // it -- copied first, so a missing one fails before the runtime changes.
    fs.copyFileSync(
      path.join(path.dirname(source), 'THIRD_PARTY_NOTICES'),
      path.join(path.dirname(installed), 'THIRD_PARTY_NOTICES'),
    );
    fs.copyFileSync(path.join(PLUGIN, 'LICENSE'), path.join(path.dirname(installed), 'LICENSE'));
    backup(installed);
    fs.renameSync(staged, installed);
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }
  log(`   installed: ${installed}`);
  return installed;
}

const RUNTIME_PACKAGE = 'severally-runtime';
// Why plugin mode registers Codex directly (no global command), or null.
let codexDirect = null;
let globalRoot = null;
// Run from a global install of the npm package, the global install below
// would replace the very package this script and its plugin files are read
// from. Refused before anything changes.
if (mode === 'plugin' && !skipGlobal) {
  const npmRoot = tryRun('npm', ['root', '-g'], { real: true });
  globalRoot = npmRoot.ok ? npmRoot.out.trim() || null : null;
  /** @param {string} dir */
  const inside = (dir) => {
    try {
      return fs.realpathSync(root).startsWith(fs.realpathSync(dir) + path.sep);
    } catch {
      return false;
    }
  };
  if (globalRoot && inside(globalRoot)) {
    throw new Error(
      'severally-install was run from a global npm install of severally-mcp, which installing would replace. ' +
        'Remove it (npm uninstall -g severally-mcp), then run npx -y severally-mcp@latest install, or install from a clone.',
    );
  }
}

step(`Installing the standalone MCP server (mode: ${mode})`);
const serverCommand = [process.execPath, installRuntime()];
const runtimeDir = path.dirname(serverCommand[1]);
const marketplaceRoot = path.join(home, '.severally', 'marketplace');

if (mode === 'plugin') {
  // npm may symlink a directory install. Its source must therefore be the
  // persistent runtime, never the user's disposable checkout.
  // The runtime goes global under a name of its own: under the npm package's
  // name and version, npx would run this installer-less copy for
  // `npx severally-mcp@<that version> install` instead of fetching the package.
  const packageFile = path.join(runtimeDir, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!dryRun) {
    backup(packageFile);
    fs.writeFileSync(
      packageFile,
      `${JSON.stringify(
        { name: RUNTIME_PACKAGE, version: metadata.version, type: 'module', bin: { 'severally-mcp': 'severally-mcp.mjs' } },
        null,
        2,
      )}\n`,
    );
    fs.chmodSync(serverCommand[1], 0o755);
  }
  if (skipGlobal) {
    const existing = runtimeCommand();
    if (!dryRun && (!existing || fs.realpathSync(existing) !== fs.realpathSync(serverCommand[1]))) {
      throw new Error(
        '--skip-global requires severally-mcp on PATH to point to the installed runtime. Omit --skip-global or use --manual.',
      );
    }
    log('   --skip-global: using the existing runtime command');
  } else {
    // Installs before the rename put the runtime there under the package's
    // own name; its severally-mcp command would collide with the new one.
    if (globalRoot && fs.existsSync(path.join(globalRoot, metadata.name))) {
      const r = tryRun('npm', ['uninstall', '-g', metadata.name]);
      log(
        r.ok
          ? `   removed the global ${metadata.name} package (the runtime is now ${RUNTIME_PACKAGE})`
          : `   could not remove the global ${metadata.name} package: ${r.out}`,
      );
    }
    const r = tryRun('npm', ['install', '-g', runtimeDir, '--install-links=false'], { cwd: dryRun ? root : runtimeDir });
    if (which('nodenv')) tryRun('nodenv', ['rehash']);
    if (!r.ok) {
      codexDirect = `npm could not install the severally-mcp command globally (${r.out.split('\n').find((l) => /ERR|EACCES|EPERM/.test(l)) ?? r.out.split('\n')[0]})`;
    } else if (!dryRun) {
      const installedCommand = runtimeCommand();
      if (!installedCommand || fs.realpathSync(installedCommand) !== fs.realpathSync(serverCommand[1])) {
        codexDirect = "npm's global severally-mcp command is not first on PATH";
      }
    }
    if (codexDirect) log(`   ${codexDirect}; Codex will be registered directly instead, which needs no global command`);
  }
  if (dryRun) {
    backupTree(marketplaceRoot);
    log(`   [dry-run] copy plugin and marketplace -> ${marketplaceRoot}`);
  } else {
    // Replace the complete owned tree: merging would retain hooks or skills
    // removed in a newer release. Keep the old tree until the new one lands.
    const staging = fs.mkdtempSync(path.join(home, '.severally', '.marketplace-'));
    const next = path.join(staging, 'next');
    const previous = path.join(staging, 'previous');
    let installed = false;
    try {
      fs.mkdirSync(path.join(next, '.agents', 'plugins'), { recursive: true });
      copyTree(PLUGIN, path.join(next, 'plugins', 'severally'));
      fs.copyFileSync(
        path.join(root, '.agents', 'plugins', 'marketplace.json'),
        path.join(next, '.agents', 'plugins', 'marketplace.json'),
      );
      backupTree(marketplaceRoot);
      if (fs.existsSync(marketplaceRoot)) fs.renameSync(marketplaceRoot, previous);
      try {
        fs.renameSync(next, marketplaceRoot);
      } catch (error) {
        if (fs.existsSync(previous)) fs.renameSync(previous, marketplaceRoot);
        throw error;
      }
      installed = true;
    } finally {
      if (installed || !fs.existsSync(previous)) fs.rmSync(staging, { recursive: true, force: true });
      else log(`   Previous marketplace preserved for recovery: ${previous}`);
    }
  }
} else {
  log('   Global npm installation is not needed in manual mode (--skip-global is optional).');
}
log(`   server command: ${JSON.stringify(serverCommand)}`);

const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
// consult_get waits 45 s by default, under the 60 s that some MCP clients
// allow a tool call. A client known to wait longer is registered with this,
// so one consult_get usually covers a whole consultation. The plugin's own
// .mcp.json carries the same value for Claude Code, and its Codex manifest
// with tool_timeout_sec 660 (codex 0.163 stops a tool call at 300 s by
// default, progress notwithstanding). `codex mcp add` cannot set that
// timeout, so a --manual Codex gets it as one line written into config.toml
// under [mcp_servers.severally] (see the Codex row), together with the env;
// both or neither, since the wait without the timeout would outlast Codex's
// own deadline.
const LONG_WAIT = 'SEVERALLY_MAX_WAIT_MS=600000';
const AGY_WAIT = 'SEVERALLY_MAX_WAIT_MS=165000';
const agyConfig = path.join(home, '.gemini', 'config', 'mcp_config.json');
const CODEX_TIMEOUT_SEC = 660;
const codexConfig = path.join(codexHome, 'config.toml');
// The user's own tool_timeout_sec, read before --force removes the table that holds it.
/** @type {number | undefined} */
let priorCodexTimeout;

// Where [mcp_servers.severally] sits in config.toml, and what it holds.
// A minimal text read, not a TOML parser: the table runs to the next header
// that is not one of its own sub-tables (codex may put env in one).
/** @returns {{ reason: string, lines?: undefined, start?: undefined, timeout?: undefined, wait?: undefined } | { reason?: undefined, lines: string[], start: number, timeout: number | undefined, wait: boolean }} */
function codexTable() {
  /** @type {string[]} */
  let lines;
  try {
    lines = fs.readFileSync(codexConfig, 'utf8').split('\n');
  } catch (err) {
    return { reason: `cannot read ${codexConfig}: ${/** @type {Error} */ (err).message}` };
  }
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\.severally\s*\]/.test(l));
  if (start < 0) return { reason: `${codexConfig} has no [mcp_servers.severally] table` };
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l) && !/^\s*\[\s*mcp_servers\.severally\./.test(l));
  if (end < 0) end = lines.length;
  const block = lines.slice(start + 1, end).join('\n');
  const timeout = block.match(/^\s*tool_timeout_sec\s*=\s*(\d+(?:\.\d+)?)/m)?.[1];
  return {
    lines,
    start,
    timeout: timeout === undefined ? undefined : Number(timeout),
    wait: /SEVERALLY_MAX_WAIT_MS\s*=\s*"?\d+/.test(block),
  };
}

// The wait follows the timeout Codex will enforce: 15 s under the user's own
// tool_timeout_sec when that is short, else the full 600000 ms.
function codexPlan() {
  const sec = priorCodexTimeout ?? CODEX_TIMEOUT_SEC;
  return { sec, ms: sec < 615 ? Math.max(0, Math.floor((sec - 15) * 1000)) : 600000 };
}

// Inserts tool_timeout_sec right after the table header. Returns why it could
// not, or null.
/** @param {number} sec */
function writeCodexTimeout(sec) {
  const t = /** @type {{ reason?: string, lines: string[], start: number, timeout?: number }} */ (codexTable());
  if (t.reason) return t.reason;
  if (t.timeout !== undefined) return null; // never overwrite the user's value
  t.lines.splice(t.start + 1, 0, `tool_timeout_sec = ${sec}`);
  try {
    fs.writeFileSync(codexConfig, t.lines.join('\n'));
  } catch (err) {
    return `cannot write ${codexConfig}: ${/** @type {Error} */ (err).message}`;
  }
  return null;
}

const claudeSkillsDir = path.join(home, '.claude', 'skills');

// ---------------------------------------------------------------- clients
/**
 * @typedef {{ ok: boolean, out: string }} RunResult
 * @typedef {object} Client
 * @property {string} bin
 * @property {string} label
 * @property {string[]} backup
 * @property {() => boolean} isRegistered
 * @property {() => RunResult} remove
 * @property {(bin: string[]) => RunResult} add
 * @property {() => void} [keptNote]
 * @property {boolean} [verifyAdd]
 * @property {string[]} [registrationConfig]
 * @property {string} skillFrom
 * @property {string} skillTo
 */
// Each row fully describes how to register a client's MCP server directly
// (through the client's own `mcp add`) and place its skill. This is the one
// place that knows how severally is installed outside of a bundled
// plugin: --manual mode installs every row this way, and the default plugin
// mode falls back to the Antigravity and OpenCode rows alone, since those
// two have no verified plugin-install path.
/** @type {Client[]} */
const CLIENTS = [
  {
    bin: 'claude',
    label: 'Claude Code',
    backup: [path.join(home, '.claude.json')],
    // `claude mcp get` exits non-zero when the server is not registered.
    isRegistered: () => tryRun('claude', ['mcp', 'get', 'severally'], { real: true }).ok,
    remove: () => tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'severally']),
    // Claude Code waits on a tool call far longer than consult_get's ten
    // minutes, so its consult_get may wait that long (see LONG_WAIT).
    add: (bin) => tryRun('claude', ['mcp', 'add', '--scope', 'user', 'severally', '--env', LONG_WAIT, '--', ...bin]),
    skillFrom: path.join(PLUGIN, 'skills', 'claude', 'severally'),
    skillTo: path.join(claudeSkillsDir, 'severally'),
  },
  {
    bin: 'codex',
    label: 'Codex',
    backup: [path.join(codexHome, 'config.toml')],
    isRegistered: () => tryRun('codex', ['mcp', 'get', 'severally'], { real: true }).ok,
    remove: () => {
      priorCodexTimeout = codexTable().timeout;
      return tryRun('codex', ['mcp', 'remove', 'severally']);
    },
    // The long wait is the env plus tool_timeout_sec in config.toml, both or neither.
    add: (bin) => {
      const { sec, ms } = codexPlan();
      const r = tryRun('codex', ['mcp', 'add', 'severally', '--env', `SEVERALLY_MAX_WAIT_MS=${ms}`, '--', ...bin]);
      if (!r.ok) return r;
      if (dryRun) {
        log(`   [dry-run] write tool_timeout_sec = ${sec} into ${codexConfig} under [mcp_servers.severally]`);
        return r;
      }
      const why = writeCodexTimeout(sec);
      if (!why) {
        log(`   consult_get waits up to ${ms / 1000} s (SEVERALLY_MAX_WAIT_MS=${ms}, tool_timeout_sec = ${sec})`);
        return r;
      }
      const back = tryRun('codex', ['mcp', 'remove', 'severally']);
      if (!back.ok) return back;
      log(`   the long consult_get wait was not set (it stays 45 s): ${why}`);
      return tryRun('codex', ['mcp', 'add', 'severally', '--', ...bin]);
    },
    keptNote: () => {
      const t = codexTable();
      if (t.timeout === undefined || !t.wait) {
        log(
          `   this registration lacks the long consult_get wait (45 s); --force adds it (SEVERALLY_MAX_WAIT_MS and tool_timeout_sec = ${CODEX_TIMEOUT_SEC})`,
        );
      }
    },
    skillFrom: path.join(PLUGIN, 'skills', 'codex', 'severally'),
    skillTo: path.join(codexHome, 'skills', 'severally'),
  },
  {
    bin: 'agy',
    label: 'Antigravity',
    backup: [
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    ],
    // agy has no `mcp get`; list and look for the name.
    isRegistered: () => {
      const r = tryRun('agy', ['mcp', 'list'], { real: true });
      return r.ok && /severally/.test(r.out);
    },
    remove: () => tryRun('agy', ['mcp', 'remove', 'severally']),
    // agy stops an MCP tool call at 3 minutes, progress notifications or not
    // (measured: a 310 s call ended at 180 s), so its wait is 15 s under that.
    add: (bin) => tryRun('agy', ['mcp', 'add', '--env', AGY_WAIT, 'severally', ...bin]),
    keptNote: () => {
      if (!/SEVERALLY_MAX_WAIT_MS/.test(fs.existsSync(agyConfig) ? fs.readFileSync(agyConfig, 'utf8') : '')) {
        log('   this registration lacks the longer consult_get wait (45 s); --force adds it (SEVERALLY_MAX_WAIT_MS=165000)');
      }
    },
    skillFrom: path.join(PLUGIN, 'skills', 'antigravity', 'severally'),
    skillTo: path.join(home, '.gemini', 'config', 'skills', 'severally'),
  },
  {
    bin: 'opencode',
    label: 'OpenCode',
    backup: [path.join(xdgConfig, 'opencode', 'opencode.json'), path.join(xdgConfig, 'opencode', 'opencode.jsonc')],
    // opencode has no `mcp get`; list and look for the exact server name.
    // `mcp list` prints through the prompt library, but the per-server lines
    // still reach stdout when stdout is not a TTY ("✓ severally  connected").
    // The name must stand alone: a substring match would accept a lookalike
    // server such as "severally-old" as this one.
    isRegistered: () => {
      const r = tryRun('opencode', ['mcp', 'list'], { real: true });
      lastListOutput = r.out;
      return r.ok && /(^|\s)severally(\s|$)/.test(r.out);
    },
    // opencode has no `mcp remove`; `mcp add` with the same name replaces
    // the entry, so a --force re-registration needs no removal first.
    // Uninstall is a hand edit of the global config (see the README).
    // --global matters: without it opencode 1.18.31 writes the registration
    // into the current project's opencode.json, and the server would be
    // reachable only inside whatever directory the installer happened to
    // run from.
    remove: () => ({ ok: true, out: 'opencode has no mcp remove; re-adding replaces the entry' }),
    // OpenCode sets no deadline of its own on a tool call (a 610 s call came
    // back), so it gets the long consult_get wait with no timeout to pair.
    // opencode 1.19 (its npm release) has no --global and always writes the
    // global config; it is asked again without the flag, from the home
    // folder, and the check after the add confirms where it landed.
    add: (bin) => {
      const r = tryRun('opencode', ['mcp', 'add', 'severally', '--global', '--env', LONG_WAIT, '--', ...bin]);
      return r.ok ? r : tryRun('opencode', ['mcp', 'add', 'severally', '--env', LONG_WAIT, '--', ...bin], { cwd: home });
    },
    keptNote: () => {
      const text = [path.join(xdgConfig, 'opencode', 'opencode.json'), path.join(xdgConfig, 'opencode', 'opencode.jsonc')]
        .map((f) => {
          try {
            return fs.readFileSync(f, 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');
      if (!text.includes('SEVERALLY_MAX_WAIT_MS'))
        log('   this registration lacks the long consult_get wait (45 s); --force adds it (SEVERALLY_MAX_WAIT_MS)');
    },
    // A zero exit from `mcp add` can be a usage dump in disguise (see above),
    // so this client's registration is verified by listing after adding --
    // and the recorded command is compared against this install's.
    verifyAdd: true,
    registrationConfig: [path.join(xdgConfig, 'opencode', 'opencode.json'), path.join(xdgConfig, 'opencode', 'opencode.jsonc')],
    skillFrom: path.join(PLUGIN, 'skills', 'opencode', 'severally'),
    skillTo: path.join(xdgConfig, 'opencode', 'skills', 'severally'),
  },
];
const codexClient = /** @type {Client} */ (CLIENTS.find((c) => c.bin === 'codex'));
const antigravityClient = /** @type {Client} */ (CLIENTS.find((c) => c.bin === 'agy'));
const opencodeClient = /** @type {Client} */ (CLIENTS.find((c) => c.bin === 'opencode'));

// opencode re-adds in place and has no `mcp remove`, so --force over an
// existing registration can silently keep the OLD command while the
// name-only list check passes. The global config is where the CLI records
// the server command; confirm it matches what this install registers.
/**
 * @param {Client} client
 * @param {string[]} bin
 */
function registrationCommandMatches(client, bin) {
  for (const file of client.registrationConfig ?? []) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      continue;
    }
    const entry = cfg.mcp?.servers?.severally ?? cfg.mcp?.severally;
    const command = entry?.command ?? entry;
    if (Array.isArray(command)) return JSON.stringify(command) === JSON.stringify(bin);
  }
  return false;
}

// The list right after an add can be briefly empty, so it is asked up to
// three times, 1.5 s apart, before the add is judged.
/** @param {Client} client */
function listedAfterAdd(client) {
  for (let i = 0; i < 3; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    if (client.isRegistered()) return true;
  }
  return false;
}

// Registers one client's MCP server directly (through its own `mcp add`) and
// copies its skill, backing up everything it touches first. Shared by plugin
// mode (Antigravity only) and --manual mode (all three clients).
/**
 * @param {Client} client
 * @param {string[]} bin
 */
function installClientDirectly(client, bin) {
  step(`Registering with ${client.label}`);
  if (!which(client.bin)) {
    log(`   ${client.bin} CLI not found on PATH — skipped`);
    return;
  }
  for (const f of client.backup) backup(f);
  if (client.isRegistered() && !force) {
    keptRegistrations = true;
    log('   already registered; leaving it as it is (use --force to re-register)');
    client.keptNote?.();
  } else {
    if (client.isRegistered()) client.remove();
    const r = client.add(bin);
    if (!r.ok) {
      log(`   failed: ${r.out}`);
      process.exitCode = 1;
    } else if (!dryRun && client.verifyAdd && !listedAfterAdd(client)) {
      // opencode prints usage and exits 0 on flags a future version renames,
      // so a zero exit from `mcp add` proves nothing: confirm the entry is
      // actually listed, or the server silently never reaches the client.
      // Its list has also come back empty with the server in its config
      // (twice, on the first run after an upgrade), so a config
      // holding exactly this install's command is a registration, noted.
      const said = `   the list said: ${lastListOutput.slice(0, 500) || '(nothing)'}`;
      if (registrationCommandMatches(client, bin)) {
        log(`   registered in ${client.label}'s global config, but \`${client.bin} mcp list\` does not show it yet`);
        log(said);
        log(`   check with \`${client.bin} mcp list\` after restarting it`);
      } else {
        log('   add exited 0 but the server is not listed; registration failed');
        log(said);
        process.exitCode = 1;
      }
    } else if (!dryRun && client.verifyAdd && !registrationCommandMatches(client, bin)) {
      log('   registration not verified: the listed server command does not match this install');
      process.exitCode = 1;
    } else {
      log('   registered');
    }
  }

  const parent = path.dirname(client.skillTo);
  if (!fs.existsSync(parent) && !dryRun) fs.mkdirSync(parent, { recursive: true });
  const saved = backupTree(client.skillTo);
  if (saved) log(`   backed up the existing ${client.label} skill to ${saved}`);
  if (dryRun) {
    log(`   [dry-run] copy ${client.skillFrom} -> ${client.skillTo}`);
    return;
  }
  fs.rmSync(client.skillTo, { recursive: true, force: true });
  copyTree(client.skillFrom, client.skillTo);
  log(`   skill: ${client.skillTo}`);
}

// A Claude Code that has severally from a marketplace (/plugin install
// severally@severally) loads that copy, and a skills-dir copy or user-scope
// registration from this installer would load beside it as a second server
// and skill (verified with claude 2.1.302). Claude Code is left to it.
// Returns the plugin's id (severally@<marketplace>), or false.
function claudeHasMarketplacePlugin() {
  if (!which('claude')) return false;
  const r = tryRun('claude', ['plugin', 'list', '--json'], { real: true });
  try {
    return (
      (r.ok &&
        JSON.parse(r.out).find((/** @type {{ id: string }} */ p) => /^severally@/.test(p.id) && p.id !== 'severally@skills-dir')
          ?.id) ||
      false
    );
  } catch {
    return false;
  }
}
const claudeMarketplace = claudeHasMarketplacePlugin();

function leaveClaudeToMarketplace() {
  step('Claude Code has severally from the marketplace; leaving Claude Code to it');
  const skill = path.join(claudeSkillsDir, 'severally');
  if (fs.existsSync(skill)) {
    const saved = backupTree(skill);
    if (!dryRun) fs.rmSync(skill, { recursive: true, force: true });
    log(`   removed this installer's earlier copy ${skill}; backup: ${saved}`);
  }
  if (tryRun('claude', ['mcp', 'get', 'severally'], { real: true }).ok) {
    backup(path.join(home, '.claude.json'));
    const r = tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'severally']);
    log(r.ok ? '   removed the user-scope MCP registration' : `   could not remove the user-scope registration: ${r.out}`);
  }
  // Brought to this release too, so one install run updates every copy.
  const updated =
    tryRun('claude', ['plugin', 'marketplace', 'update', 'severally'], { timeout: 120_000 }).ok &&
    tryRun('claude', ['plugin', 'update', claudeMarketplace], { timeout: 120_000 }).ok;
  log(
    updated
      ? `   updated ${claudeMarketplace} from its marketplace`
      : '   could not update it here; in Claude Code run /plugin marketplace update severally',
  );
}

// A previous plugin installation would otherwise retain its old checkout
// marketplace alongside a new direct server registration.
function removeCodexLocalMarketplace() {
  if (!which('codex')) return;
  const known = tryRun('codex', ['plugin', 'marketplace', 'list'], { real: true });
  if (known.ok && known.out.includes('severally-local')) {
    backup(path.join(codexHome, 'config.toml'));
    tryRun('codex', ['plugin', 'remove', 'severally', '--marketplace', 'severally-local']);
    run('codex', ['plugin', 'marketplace', 'remove', 'severally-local']);
  }
}

if (mode === 'plugin') {
  // ------------------------------------------------------------- plugin mode
  if (claudeMarketplace) leaveClaudeToMarketplace();
  else {
    step('Installing the plugin into Claude Code (skills-dir plugin, no marketplace)');
    const target = path.join(claudeSkillsDir, 'severally');
    const saved = backupTree(target);
    if (saved) log(`   backed up the existing ${target} to ${saved}`);
    if (dryRun) {
      log(`   [dry-run] copy ${PLUGIN} -> ${target}`);
    } else {
      fs.mkdirSync(claudeSkillsDir, { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      copyTree(PLUGIN, target);
      log(`   installed: ${target} (loads as severally@skills-dir)`);
    }
    // A user-scope MCP registration would duplicate the one the plugin provides.
    if (which('claude')) {
      const dup = tryRun('claude', ['mcp', 'get', 'severally'], { real: true });
      if (dup.ok) {
        backup(path.join(home, '.claude.json'));
        const r = tryRun('claude', ['mcp', 'remove', '--scope', 'user', 'severally']);
        log(
          r.ok
            ? '   removed the duplicate user-scope MCP registration'
            : `   could not remove the duplicate registration: ${r.out}`,
        );
      }
    }
  }

  if (codexDirect && which('codex')) {
    removeCodexLocalMarketplace();
    installClientDirectly(codexClient, serverCommand);
  } else {
    step('Installing the plugin into Codex (managed local marketplace)');
    if (!which('codex')) {
      log('   codex CLI not found on PATH — skipped');
    } else {
      backup(path.join(codexHome, 'config.toml'));
      const marketplace = 'severally-local';
      const known = tryRun('codex', ['plugin', 'marketplace', 'list'], { real: true });
      if (!known.ok) throw new Error(`Could not inspect Codex marketplaces: ${known.out}`);
      // Refresh our own registration even when already present: older installs
      // registered the checkout here. Reusing it would retain that dependency.
      if (known.out.includes(marketplace)) {
        tryRun('codex', ['plugin', 'remove', 'severally', '--marketplace', marketplace]);
        run('codex', ['plugin', 'marketplace', 'remove', marketplace]);
      }
      run('codex', ['plugin', 'marketplace', 'add', marketplaceRoot]);
      log(`   marketplace added: ${marketplace} -> ${marketplaceRoot}`);
      const r = tryRun('codex', ['plugin', 'add', `severally@${marketplace}`]);
      log(r.ok ? '   plugin installed' : `   plugin install failed: ${r.out}`);
      if (!r.ok) process.exitCode = 1;
      // Same duplication concern on the Codex side.
      const dup = tryRun('codex', ['mcp', 'get', 'severally'], { real: true });
      if (dup.ok) {
        const rm = tryRun('codex', ['mcp', 'remove', 'severally']);
        log(
          rm.ok
            ? '   removed the duplicate global MCP registration'
            : `   could not remove the duplicate registration: ${rm.out}`,
        );
      }
      const strayCodexSkill = path.join(codexHome, 'skills', 'severally');
      if (fs.existsSync(strayCodexSkill)) {
        const s2 = backupTree(strayCodexSkill);
        if (!dryRun) fs.rmSync(strayCodexSkill, { recursive: true, force: true });
        log(`   removed the hand-copied skill (the plugin supplies it); backup: ${s2}`);
      }
    }
  }

  // Antigravity has no verified plugin-install mechanism (no marketplace or
  // plugin-add path confirmed against agy 1.1.28), and OpenCode has no plugin
  // mechanism at all, so both are registered directly here too -- the same
  // `mcp add` + skill copy that --manual mode uses for every client.
  log('\nAntigravity and OpenCode have no plugin-install path; registering them directly.');
  installClientDirectly(antigravityClient, serverCommand);
  installClientDirectly(opencodeClient, serverCommand);
} else {
  // ------------------------------------------------------------- manual mode
  removeCodexLocalMarketplace();
  for (const client of CLIENTS) {
    if (client.bin === 'claude' && claudeMarketplace) leaveClaudeToMarketplace();
    else installClientDirectly(client, serverCommand);
  }
}

// ---------------------------------------------------------------- local tools
// Five of the six tools stay on this machine; Claude Code asks before each
// call unless they are allowed, so a first consultation can stop on prompt
// after prompt. Offered here, never assumed: consult_start, which sends the
// brief out, keeps asking.
const LOCAL_TOOLS = ['consult_get', 'consult_list', 'consult_cancel', 'consult_record', 'consult_export'];
async function allowLocalTools() {
  if (!which('claude')) return;
  const prefix = mode === 'plugin' || claudeMarketplace ? 'mcp__plugin_severally_severally__' : 'mcp__severally__';
  const settingsFile = path.join(home, '.claude', 'settings.json');
  /** @type {{ permissions?: { allow?: string[] } & Record<string, unknown> } & Record<string, unknown>} */
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code !== 'ENOENT') {
      log(`   could not read ${settingsFile} (${err.message}); left as it is`);
      return;
    }
  }
  const allow = settings.permissions?.allow ?? [];
  const missing = LOCAL_TOOLS.map((t) => prefix + t).filter((t) => !allow.includes(t));
  if (!missing.length) return;
  step('Claude Code tool permissions');
  let yes = argv.has('--allow-local-tools');
  if (!yes && process.stdin.isTTY && process.stdout.isTTY && !dryRun) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `   Let Claude Code run ${LOCAL_TOOLS.join(', ')} without asking each time?\n` +
        '   They send nothing off this machine; consult_start, which does, still asks. [Y/n] ',
    );
    rl.close();
    yes = !/^\s*n/i.test(answer);
  }
  if (!yes) {
    log(`   not changed; rerun with --allow-local-tools to allow them in ${settingsFile}`);
    return;
  }
  if (dryRun) {
    log(`   [dry-run] add ${missing.join(', ')} to permissions.allow in ${settingsFile}`);
    return;
  }
  backup(settingsFile);
  settings.permissions = { ...settings.permissions, allow: [...allow, ...missing] };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  log(`   allowed in ${settingsFile}: ${missing.join(', ')}`);
}
await allowLocalTools();

// ---------------------------------------------------------------- summary
step('Done');
if (fs.existsSync(backupDir)) log(`   backups: ${backupDir}`);
if (keptRegistrations) {
  log('   Existing MCP registrations were kept. Rerun with --force before deleting the source checkout.');
} else if (!dryRun && !process.exitCode) {
  log('   The registered server and skills no longer depend on the source checkout.');
}
log(
  mode === 'plugin'
    ? `
Verify with:
  claude plugin details severally
  ${codexDirect ? 'codex  mcp get severally' : 'codex  plugin list'}
  agy    mcp list
  opencode mcp list

Restart any running client session to pick the plugin up. In Claude Code the tools then appear as
mcp__plugin_severally_severally__consult_start / _get / _cancel / _list.

Re-run this after "npm run build" to push an updated plugin to ${claudeMarketplace ? 'Codex' : 'both clients'} (Antigravity and
OpenCode are registered directly each run, so a re-run always refreshes them too).`
    : `
Verify with:
  claude mcp get severally
  codex  mcp get severally
  agy    mcp list
  opencode mcp list

In a new Claude Code session the tools appear as mcp__severally__consult_start / _get / _cancel / _list.
Restart any running client session to pick the server up.`,
);
