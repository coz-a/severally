// Isolation for the Antigravity CLI.
//
// agy has no flag equivalent to codex --ignore-user-config or claude
// --restricted --strict-mcp-config: everything (MCP servers, hooks, skills,
// plugins, permissions, conversation history) is read from ~/.gemini. So the
// isolation is built by handing the child a synthesised HOME that contains
// nothing but a linked credential and two files we wrote ourselves:
//
//   .gemini/config/mcp_config.json      {}  -> zero MCP servers = recursion barrier
//   .gemini/antigravity-cli/settings.json   -> deny writes/commands/mcp, allow read_url
//   .gemini/config/hooks.json               -> a PreToolUse hook that runs
//                                              tool-allowlist.mjs before every tool
//
// Anything not in that tree cannot be inherited: no user hooks, no skills/,
// no plugins, no projects/ overrides. Conversation state is written inside the
// tree and deleted with it, which is what --ephemeral gives us on Codex.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { credentialsHome, protectedRootPatterns, protectedNamePatterns, PATHS_CASE_INSENSITIVE } from '../policy.mjs';
import { sandboxHome } from '../store.mjs';

// Verified against agy 1.1.28: precedence is Deny > Ask > Allow, and headless
// mode auto-denies anything that would need a prompt. read_url must be allowed
// explicitly or the consultant can search but never open a page; search_web
// needs no rule. Every consultant receives its brief on stdin, so file-system
// reads are neither needed nor wanted.
// read_file is allowed, not denied: the three consultants have to be equal
// readers. Codex's child is sandboxed read-only rather than execution-free, so
// it could always read the disk; leaving the other two unable to meant the same
// brief reached three differently-equipped readers. command(*) stays denied, so
// this child reads files without gaining a shell.
export const SANDBOX_ALLOW = Object.freeze(['read_url(*)', 'read_file(*)']);
export const SANDBOX_DENY = Object.freeze([
  'write_file(*)',
  'command(*)',
  'mcp(*)',
  'execute_url(*)',
  'unsandboxed(*)',
]);

// The permission rules above cover only the categories agy asks permission
// for. Its agent tools ask for none: on 2026-10-17 a consultant called
// invoke_subagent under these rules and a child agent started. So every tool
// call also passes a PreToolUse hook that allows these names and denies the
// rest -- an allowlist, so a tool a later agy release adds is refused until it
// is added here. The names are agy's own (its init toolset), not rule names.
export const ALLOWED_TOOLS = Object.freeze(['view_file', 'search_web', 'read_url_content', 'finish']);
const WEB_TOOLS = new Set(['search_web', 'read_url_content']);

// agy pipes the pending call to the hook as {"toolCall":{"name":...,
// "args":{...}}} (verified against agy 1.4.0, 2026-10-17; `parameters` is read
// too, for older releases) and reads a decision from stdout; no output lets the
// call through. So the hook always answers, allow included, and anything it
// cannot read or check -- broken JSON, a stdin error, arguments nested past
// what it walks, an exception of its own -- is denied. A hook that never runs
// or is killed answers nothing, and that stays agy's call: agy 1.4.2 fails such
// a call rather than running it ("JSON hook ... failed: command failed: ..."),
// checked live on 2026-10-20 with invoke_subagent against a hook that exited 1,
// exited 2, outlived the 10 s timeout, and whose script was missing -- each
// time the step ended in ERROR and no child agent started. For the file-reading tool
// and for a file: URL, every path-like parameter is also checked against the
// protected roots and file names, before and after resolving links, with ~
// expanded: a consultant that can browse must not read a credential and
// carry it out in a URL. Other tools' parameters -- the final answer passed
// to finish among them -- are text, not paths, and are not inspected.
const PATH_TOOLS = ['view_file', 'read_url_content'];

// read_url_content does not hand a long page to the model: it saves it inside
// the sandbox home and tells the model to view_file that copy (agy 1.4.0,
// 2026-10-17). The sandbox home is protected as a whole, so without this one
// exception no long page could be read. Only that file shape, only in this
// sandbox: the rest of the home (credential link, transcripts) stays refused.
function spillPattern(root) {
  const esc = (s) => s.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let real = root;
  try { real = fs.realpathSync.native(root); } catch { /* not created yet: the root as given */ }
  const roots = [...new Set([root, real])].map(esc).join('|');
  return `^(?:${roots})/\\.gemini/antigravity-cli/brain/[^/]+/\\.system_generated/steps/[0-9]+/content\\.md$`;
}

function hookSource(allowed, rootPatterns, namePatterns, home, spill) {
  return `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const allowed = new Set(${JSON.stringify(allowed)});
const pathTools = new Set(${JSON.stringify(PATH_TOOLS)});
const flags = ${JSON.stringify(PATHS_CASE_INSENSITIVE ? 'i' : '')};
const roots = ${JSON.stringify(rootPatterns)}.map((p) => new RegExp(p, flags));
const names = ${JSON.stringify(namePatterns)}.map((p) => new RegExp(p, flags));
const spill = new RegExp(${JSON.stringify(spill)}, flags);
const home = ${JSON.stringify(home)};
// Relative strings resolve against the consultant's workspace, which agy
// sends as workspacePaths, never against this hook's own cwd: that is inside
// the protected sandbox home, and would turn a tool's description text
// ("Reading control.txt") into a protected path.
function candidates(v, base) {
  if (typeof v !== 'string' || !v) return [];
  if (/^file:/i.test(v)) { try { return [fileURLToPath(v)]; } catch { return [v]; } }
  if (/^[a-z][a-z0-9+.-]*:\\/\\//i.test(v)) return [];
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\\\')) return [path.join(home, v.slice(1))];
  if (path.isAbsolute(v)) return [v];
  return base ? [path.join(base, v)] : [];
}
function protectedPath(v, base) {
  return candidates(v, base).some((c) => {
    const given = path.resolve(c);
    let real = given;
    try { real = fs.realpathSync.native(given); } catch {}
    return [given, real].some((p) => {
      const fwd = p.split(path.sep).join('/');
      if (spill.test(fwd)) return false;
      return roots.some((re) => re.test(fwd)) || names.some((re) => re.test(path.basename(fwd)));
    });
  });
}
function strings(o, out = [], depth = 0) {
  if (depth > 32) throw new Error('arguments nested too deep to check');
  if (typeof o === 'string') out.push(o);
  else if (o && typeof o === 'object') for (const v of Object.values(o)) strings(v, out, depth + 1);
  return out;
}
let decided = false;
function decide(reason) {
  if (decided) return;
  decided = true;
  process.stdout.write(JSON.stringify(reason ? { decision: 'deny', reason } : { decision: 'allow' }));
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => decide('severally could not read this tool call'));
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    let call = null;
    let base = null;
    try {
      const msg = JSON.parse(input);
      call = msg.toolCall;
      base = Array.isArray(msg.workspacePaths) && typeof msg.workspacePaths[0] === 'string' ? msg.workspacePaths[0] : null;
    } catch {}
    const name = call && typeof call.name === 'string' ? call.name : null;
    let reason = null;
    if (!name || !allowed.has(name)) reason = 'severally consultants may not use ' + (name || 'this tool');
    else if (pathTools.has(name) && strings([call.args, call.parameters]).some((v) => protectedPath(v, base))) reason = 'severally consultants may not read credential or history paths';
    decide(reason);
  } catch {
    decide('severally could not check this tool call');
  }
});
`;
}

/** The tools the hook lets through: no web tools when the request turned the network off. */
export function allowedTools(network = 'on') {
  return ALLOWED_TOOLS.filter((t) => network !== 'off' || !WEB_TOOLS.has(t));
}

/** The settings.json permission rules; with the network off, read_url moves to deny. */
export function sandboxPermissions(network = 'on') {
  if (network !== 'off') return { allow: [...SANDBOX_ALLOW], deny: [...SANDBOX_DENY] };
  return { allow: SANDBOX_ALLOW.filter((r) => r !== 'read_url(*)'), deny: [...SANDBOX_DENY, 'read_url(*)'] };
}

function hookCommand(script) {
  return [process.execPath, script].map((v) => {
    if (process.platform !== 'win32') return `'${v.replaceAll("'", "'\\''")}'`;
    if (/["%\r\n!]/.test(v)) throw new Error(`unsupported character in hook path: ${v}`);
    return `"${v}"`;
  }).join(' ');
}

const TOKEN_REL = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

/**
 * Build the synthesised HOME for one consultation.
 * @param {{workdir: string}} opts workdir is <jobdir>/work; the home is store.sandboxHome(<job id>).
 */
export function prepareSandbox({ workdir, network = 'on' }) {
  const root = sandboxHome(path.basename(path.dirname(workdir)));
  const cliDir = path.join(root, '.gemini', 'antigravity-cli');
  const cfgDir = path.join(root, '.gemini', 'config');
  fs.mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);

  fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), '{}\n', { mode: 0o600 });
  const tools = allowedTools(network);
  const hookScript = path.join(root, 'tool-allowlist.mjs');
  fs.writeFileSync(hookScript, hookSource(tools, protectedRootPatterns([root, path.join(credentialsHome(), '.gemini')]), protectedNamePatterns(), os.homedir(), spillPattern(root)), { mode: 0o600 });
  const hooks = {
    severally: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand(hookScript), timeout: 10 }] }],
    },
  };
  fs.writeFileSync(path.join(cfgDir, 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(cliDir, 'settings.json'),
    `${JSON.stringify({ permissions: sandboxPermissions(network) }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const source = path.join(credentialsHome(), TOKEN_REL);
  const link = path.join(cliDir, 'antigravity-oauth-token');
  let credentials = 'missing';
  if (fs.existsSync(source)) {
    try {
      fs.symlinkSync(source, link);
      credentials = 'symlink';
    } catch {
      // Some filesystems refuse symlinks; a copy still authenticates, but a
      // token refreshed by the child would be discarded with the sandbox.
      fs.copyFileSync(source, link);
      fs.chmodSync(link, 0o600);
      credentials = 'copy';
    }
  }

  return {
    root,
    credentials,
    tools,
    // The exact path searched, so a caller that has to report `credentials:
    // "missing"` can say where it looked instead of leaving the operator to
    // guess which HOME severally read.
    credentialsSource: source,
    env: {
      HOME: root,
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
