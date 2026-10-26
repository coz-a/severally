// Isolation for the OpenCode CLI.
//
// opencode has no flag equivalent to codex --ignore-user-config or claude
// --restricted: its global config (~/.config/opencode), its credentials and
// session store (~/.local/share/opencode: auth.json, opencode.db), plugins,
// skills and MCP servers are all resolved from the XDG directories of the
// running user, and by default it ALLOWS every operation ("By default,
// opencode allows all operations without requiring explicit approval" --
// docs/config). So the isolation is built the antigravity way: the child gets
// a synthesised HOME whose opencode content is a copied credential, one config
// file and a pre-read guard plugin we wrote ourselves.
//
//   .config/opencode/opencode.json   -> permissions: deny write/bash/task,
//                                       allow read tools and web; mcp: {},
//                                       share off, snapshots off, no autoupdate
//   .config/opencode/plugins/        -> our read guard checks lexical and real
//                                       paths before each read tool call
//   .local/share/opencode/auth.json  -> a copy of the real provider keys, so
//                                       a CLI-side credential refresh can
//                                       never write through to the operator's
//                                       store (2.x rewrites the file in place)
//
// Anything not in that tree cannot be inherited: no user MCP servers (the
// recursion barrier), no user plugins, no skills, no agents, no instructions.
// The synthesised data directory also holds the session database the child
// writes, so the brief never reaches the user's real session store and the
// whole tree is deleted with the job -- what `--ephemeral` buys on Codex.
//
// Verified against opencode 1.18.31 on Linux:
//   - global paths come from xdg-basedir (packages/core/src/global.ts), so
//     XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME / XDG_STATE_HOME and
//     HOME decide every location
//   - `opencode run` reads its prompt from stdin when stdin is not a TTY
//   - in print mode a permission that would prompt is rejected outright, and
//     "deny" rules reject the tool call itself
// On Windows xdg-basedir has no directories of its own; the USERPROFILE /
// APPDATA / LOCALAPPDATA overrides mirror the antigravity sandbox and follow
// whatever opencode resolves there.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Aliased because the esbuild banner in the shipped bundle already declares
// `createRequire` in the same module scope, and a second plain import would
// be a redeclaration.
import { createRequire as sqliteRequire } from 'node:module';
import { POLICY, opencodeCredentialsHome, protectedRoots, PROTECTED_FILE_NAMES } from '../policy.mjs';
import { sandboxHome } from '../store.mjs';
import { writeReadGuard } from './opencode-read-guard.mjs';

// node:sqlite ships unflagged from Node 23 (and late 22.x); the engines field
// allows older runtimes, where credential seeding degrades to a no-op and the
// job fails with the CLI's own auth error instead.
/** @type {typeof import('node:sqlite').DatabaseSync | null} */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = sqliteRequire(import.meta.url)('node:sqlite'));
} catch {
  /* unavailable */
}

/** The optional recovery capability, independently of normal CLI login. */
export function credentialRecoveryStatus() {
  return {
    available: DatabaseSync !== null,
    detail: DatabaseSync
      ? 'available (node:sqlite)'
      : 'unavailable (node:sqlite is not available); update Node.js to a current supported release for OpenCode 2.x credential recovery; normal CLI login is still allowed',
  };
}

/**
 * Only a bootstrapped 2.x session could need this recovery. This describes a
 * recovery we could not attempt, not the cause of the CLI's original error.
 * @param {{ root?: string }} sandbox
 */
export function credentialRecoveryUnavailableReason(sandbox) {
  if (
    DatabaseSync ||
    typeof sandbox.root !== 'string' ||
    !fs.existsSync(path.join(sandbox.root, '.local', 'share', 'opencode', 'opencode.db'))
  )
    return null;
  return `OpenCode credential recovery ${credentialRecoveryStatus().detail}`;
}

// Reading is allowed, not denied: every consultant is an equal reader (Codex
// runs a read-only shell; Claude Code and Antigravity can read the whole
// disk). Everything that changes state or reaches another agent is denied
// outright -- opencode's own default posture is the opposite of what a
// consultation needs, so nothing here may be left unspecified. Both name
// generations are pinned: opencode 2.x renamed bash -> shell and
// task -> subagent (1.18.31 still accepts the old names, and `debug config`
// normalises them), but nothing promises the aliases survive.
export const SANDBOX_DENY = Object.freeze([
  // Their permission resources are search patterns, not each returned file.
  // Searching a permitted ancestor would otherwise bypass protected read paths.
  'glob',
  'grep',
  'edit',
  'bash',
  'shell',
  'task',
  'subagent',
  'skill',
  'lsp',
  'todowrite',
  // `opencode run` denies these three itself for fresh sessions; pinned here
  // so the consultant's isolation does not rest on the CLI's incidental
  // print-mode behaviour.
  'question',
  'plan_enter',
  'plan_exit',
  // 2.x Code Mode: runs JavaScript with a global fetch, so it reached the web
  // with webfetch and websearch denied (2026-10-17, opencode 2.0.24).
  'execute',
]);
export const SANDBOX_ALLOW = Object.freeze(['read', 'webfetch', 'websearch']);
// Denied instead of allowed when the request turned the network off.
const WEB_TOOLS = new Set(['webfetch', 'websearch']);

// Hiding the state-changing tools keeps the consultant from spending turns on
// calls the permission layer would only refuse. Names that do not exist in a
// future version are inert here.
const SANDBOX_TOOLS_OFF = Object.freeze({ edit: false, write: false, patch: false, bash: false, execute: false });

// Path rules for read and for reaching outside the working directory: allow
// everything except the protected roots and file names. Without the
// external_directory rule opencode 2.x asks before reading outside the
// workdir, and a run that cannot ask refuses -- so this consultant read less
// than the others. The last matching rule wins, so "*" comes first.
/** @param {string} workdir */
function readRules(workdir) {
  const roots = protectedRoots();
  const paths = new Set(roots);
  // OpenCode 2.x uses relative resources inside its Location/worktree, even
  // for absolute read arguments. The Location may be any ancestor of cwd.
  // Keep absolute rules for external reads and relative ones for each base.
  for (let base = path.resolve(workdir); ; base = path.dirname(base)) {
    for (const root of roots) paths.add(path.relative(base, root).replaceAll('\\', '/'));
    if (base === path.dirname(base)) break;
  }
  const deny = [...paths].flatMap((r) => [r, `${r}/**`]).concat(PROTECTED_FILE_NAMES.flatMap((n) => [n, `**/${n}`]));
  return { '*': 'allow', ...Object.fromEntries(deny.map((p) => [p, 'deny'])) };
}

const AUTH_REL = path.join('.local', 'share', 'opencode', 'auth.json');

/**
 * The synthesised HOME of one consultation, as prepareSandbox returns it.
 * @typedef {object} OpencodeSandbox
 * @property {string} root
 * @property {string} credentials 'copy' or 'missing'
 * @property {string[]} tools
 * @property {string} credentialsSource
 * @property {Record<string, string>} env
 * @property {() => void} cleanup
 * @property {(provider: string) => boolean} seed insert the provider's credential into the session database
 */

/**
 * Build the synthesised HOME for one consultation.
 * @param {{workdir: string, network?: 'on' | 'off' | undefined}} opts workdir is <jobdir>/work; the home is store.sandboxHome(<job id>).
 * @returns {OpencodeSandbox}
 */
export function prepareSandbox({ workdir, network = 'on' }) {
  const root = sandboxHome(path.basename(path.dirname(workdir)));
  const configDir = path.join(root, '.config', 'opencode');
  const dataDir = path.join(root, '.local', 'share', 'opencode');
  const cacheDir = path.join(root, '.cache', 'opencode');
  const stateDir = path.join(root, '.local', 'state', 'opencode');
  for (const dir of [configDir, dataDir, cacheDir, stateDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(root, 0o700);
  writeReadGuard(configDir, workdir);

  fs.writeFileSync(
    path.join(configDir, 'opencode.json'),
    `${JSON.stringify(
      {
        permission: {
          // Anything not named below is refused, so a tool a later release adds is not let through.
          '*': 'deny',
          ...Object.fromEntries(SANDBOX_DENY.map((name) => [name, 'deny'])),
          ...Object.fromEntries(SANDBOX_ALLOW.map((name) => [name, network === 'off' && WEB_TOOLS.has(name) ? 'deny' : 'allow'])),
          read: readRules(workdir),
          external_directory: readRules(workdir),
        },
        tools: { ...SANDBOX_TOOLS_OFF, ...(network === 'off' ? { webfetch: false, websearch: false } : {}) },
        // The recursion barrier proper is the empty HOME: no user config
        // survives it. This key documents the posture in the one config the
        // child does read, and holds even if a future version widens where
        // project-level config may come from.
        mcp: {},
        // Only the operator's provider definitions cross over from config:
        // which endpoints a model can be served from, never tools or permissions.
        ...(Object.keys(POLICY.clis.opencode.provider).length ? { provider: POLICY.clis.opencode.provider } : {}),
        share: 'disabled',
        snapshot: false,
        autoupdate: false,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const source = path.join(opencodeCredentialsHome(), AUTH_REL);
  const link = path.join(dataDir, 'auth.json');
  let credentials = 'missing';
  if (fs.existsSync(source)) {
    // Always a copy, never a symlink: opencode 2.x refreshes some provider
    // credentials by rewriting auth.json in place, and a write through a
    // symlink would land in the operator's real store -- the one file here
    // that outlives the job. A stale copy is discarded with the sandbox,
    // which is exactly the right lifetime for a refreshed key.
    fs.copyFileSync(source, link);
    fs.chmodSync(link, 0o600);
    credentials = 'copy';
  }

  /** @type {OpencodeSandbox} */
  const sandbox = {
    root,
    credentials,
    tools: SANDBOX_ALLOW.filter((t) => network !== 'off' || !WEB_TOOLS.has(t)),
    // The exact path searched, so a caller that has to report `credentials:
    // "missing"` can say where it looked instead of leaving the operator to
    // guess which HOME severally read.
    credentialsSource: source,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, '.config'),
      XDG_DATA_HOME: path.join(root, '.local', 'share'),
      XDG_CACHE_HOME: path.join(root, '.cache'),
      XDG_STATE_HOME: path.join(root, '.local', 'state'),
      // Belt and braces: no update checks, no project-config pickup from the
      // parent directories of the (empty) working directory.
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      ...(process.platform === 'win32'
        ? {
            USERPROFILE: root,
            HOMEDRIVE: path.parse(root).root.replace(/[\\/]$/, ''),
            HOMEPATH: root.slice(path.parse(root).root.length - 1),
            APPDATA: path.join(root, 'AppData', 'Roaming'),
            LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
          }
        : {}),
    },
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
    seed: (provider) => seedCredentialFromAuth(sandbox, provider),
  };
  return sandbox;
}

/**
 * opencode 2.x authenticates providers from the `credential` table of the
 * session database (auth.json is the 1.x mechanism and is ignored). A run
 * that fails for lack of a credential has still created and migrated that
 * database, so the row the CLI's own `auth login` would have written can be
 * inserted from the copied auth.json and a retry will authenticate.
 *
 * The value shape was read off a live 2.0.11 login row: {"type":"key","key":…}
 * -- note "key" (the method), not the "api" auth.json uses. Only api-key
 * entries are seeded; OAuth tokens have a different shape and lifecycle.
 *
 * @param {{ root: string }} sandbox
 * @param {unknown} provider
 * @returns {boolean} true when a row was written and a retry is worth it.
 */
export function seedCredentialFromAuth(sandbox, provider) {
  if (!DatabaseSync || typeof provider !== 'string' || !provider) return false;
  const dataDir = path.join(sandbox.root, '.local', 'share', 'opencode');
  const authPath = path.join(dataDir, 'auth.json');
  const dbPath = path.join(dataDir, 'opencode.db');
  // The database must already exist: creating one ourselves would race the
  // CLI's own migrations, so an unbootstrapped sandbox is simply not seedable.
  if (!fs.existsSync(dbPath)) return false;

  /** @type {{ label: import('node:sqlite').SQLInputValue, value: string } | null} */
  let row = null;
  // The operator's session database is what the 2.x CLI itself authenticates
  // with, so it outranks the copied auth.json: an operator who rotated their
  // key through `auth login` can be left with a stale auth.json entry, and
  // seeding that would waste the single retry while the working key sat
  // unread. Among several rows the most recently updated one is the live
  // credential. Read-only, and only this one provider's row -- never a copy
  // of the store, whose sessions must not cross into the sandbox.
  const operatorDb = path.join(opencodeCredentialsHome(), '.local', 'share', 'opencode', 'opencode.db');
  if (fs.existsSync(operatorDb)) {
    try {
      const db = new DatabaseSync(operatorDb, { readOnly: true });
      try {
        const found = db
          .prepare('SELECT label, value FROM credential WHERE integration_id = ? ORDER BY time_updated DESC LIMIT 1')
          .get(provider);
        if (found && typeof found.value === 'string') {
          const parsed = JSON.parse(found.value);
          if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string' && parsed.key) {
            row = { label: found.label ?? 'API key', value: found.value };
          }
        }
      } finally {
        db.close();
      }
    } catch {
      /* unreadable or reshaped: try the auth.json source */
    }
  }
  if (!row && fs.existsSync(authPath)) {
    try {
      const entry = JSON.parse(fs.readFileSync(authPath, 'utf8'))[provider];
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.key === 'string' &&
        entry.key &&
        (!entry.type || entry.type === 'api')
      ) {
        row = { label: 'API key', value: JSON.stringify({ type: 'key', key: entry.key }) };
      }
    } catch {
      /* unreadable auth.json: nothing seedable */
    }
  }
  if (!row) return false;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        'INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(`cred_${crypto.randomBytes(18).toString('base64url')}`, provider, row.label, row.value, Date.now(), Date.now());
    } finally {
      db.close();
    }
    return true;
  } catch {
    // Schema moved or table missing: the job fails with the CLI's own error,
    // exactly as it would without this recovery.
    return false;
  }
}
