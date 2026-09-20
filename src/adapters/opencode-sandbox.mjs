// Isolation for the OpenCode CLI.
//
// opencode has no flag equivalent to codex --ignore-user-config or claude
// --restricted: its global config (~/.config/opencode), its credentials and
// session store (~/.local/share/opencode: auth.json, opencode.db), plugins,
// skills and MCP servers are all resolved from the XDG directories of the
// running user, and by default it ALLOWS every operation ("By default,
// opencode allows all operations without requiring explicit approval" --
// docs/config). So the isolation is built the antigravity way: the child gets
// a synthesised HOME whose only opencode content is a linked credential and
// one config file we wrote ourselves.
//
//   .config/opencode/opencode.json   -> permissions: deny write/bash/task,
//                                       allow read tools and web; mcp: {},
//                                       share off, snapshots off, no autoupdate
//   .local/share/opencode/auth.json  -> symlink to the real provider keys
//
// Anything not in that tree cannot be inherited: no user MCP servers (the
// recursion barrier), no plugins, no skills, no agents, no instructions.
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
import { opencodeCredentialsHome } from '../policy.mjs';

// Reading is allowed, not denied: every consultant is an equal reader (Codex
// runs a read-only shell; Claude Code and Antigravity can read the whole
// disk). Everything that changes state or reaches another agent is denied
// outright -- opencode's own default posture is the opposite of what a
// consultation needs, so nothing here may be left unspecified.
export const SANDBOX_DENY = Object.freeze([
  'edit',
  'bash',
  'task',
  'skill',
  'lsp',
  'todowrite',
  // `opencode run` denies these three itself for fresh sessions; pinned here
  // so the consultant's isolation does not rest on the CLI's incidental
  // print-mode behaviour.
  'question',
  'plan_enter',
  'plan_exit',
]);
export const SANDBOX_ALLOW = Object.freeze(['read', 'glob', 'grep', 'webfetch', 'websearch']);

// Hiding the state-changing tools keeps the consultant from spending turns on
// calls the permission layer would only refuse. Names that do not exist in a
// future version are inert here.
const SANDBOX_TOOLS_OFF = Object.freeze({ edit: false, write: false, patch: false, bash: false });

const AUTH_REL = path.join('.local', 'share', 'opencode', 'auth.json');

/**
 * Build the synthesised HOME for one consultation.
 * @param {{workdir: string}} opts workdir is <jobdir>/work; the home is its sibling.
 */
export function prepareSandbox({ workdir }) {
  const root = path.join(path.dirname(workdir), 'home');
  const configDir = path.join(root, '.config', 'opencode');
  const dataDir = path.join(root, '.local', 'share', 'opencode');
  const cacheDir = path.join(root, '.cache', 'opencode');
  const stateDir = path.join(root, '.local', 'state', 'opencode');
  for (const dir of [configDir, dataDir, cacheDir, stateDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(root, 0o700);

  fs.writeFileSync(
    path.join(configDir, 'opencode.json'),
    `${JSON.stringify(
      {
        permission: {
          ...Object.fromEntries(SANDBOX_DENY.map((name) => [name, 'deny'])),
          ...Object.fromEntries(SANDBOX_ALLOW.map((name) => [name, 'allow'])),
        },
        tools: { ...SANDBOX_TOOLS_OFF },
        // The recursion barrier proper is the empty HOME: no user config
        // survives it. This key documents the posture in the one config the
        // child does read, and holds even if a future version widens where
        // project-level config may come from.
        mcp: {},
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
    try {
      fs.symlinkSync(source, link);
      credentials = 'symlink';
    } catch {
      // Some filesystems refuse symlinks; a copy still authenticates, but a
      // key refreshed by the child would be discarded with the sandbox.
      fs.copyFileSync(source, link);
      fs.chmodSync(link, 0o600);
      credentials = 'copy';
    }
  }

  return {
    root,
    credentials,
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
      ...(process.platform === 'win32' ? {
        USERPROFILE: root,
        HOMEDRIVE: path.parse(root).root.replace(/[\\/]$/, ''),
        HOMEPATH: root.slice(path.parse(root).root.length - 1),
        APPDATA: path.join(root, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      } : {}),
    },
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
