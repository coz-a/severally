// Codex CLI adapter.
//
// Isolation applied here, not left to the parent's configuration:
//   --ignore-user-config  ~/.codex/config.toml is not read, so the user's MCP
//                         servers (severally included) and plugins never
//                         load in the consultant -- this is the recursion barrier.
//   --ignore-rules        no user/project execpolicy rules.
//   default_permissions   a permission profile in place of `-s read-only`
//                         (which, when also given, wins and drops the
//                         profile): the whole disk read-only, the shell's
//                         network off, and the protected paths unreadable.
//                         Verified against codex 0.163 on Linux (bubblewrap),
//                         2026-10-17: writes "Read-only file system", curl
//                         cannot resolve, ~/.ssh and ~/.codex/auth.json
//                         "Permission denied". Not yet run on macOS / Windows.
//                         Limits, both Linux: a denied directory becomes an
//                         empty mount, so ~/.codex is denied entry by entry
//                         (its packages/ holds the binary the sandbox
//                         re-executes); and a denied file that is replaced by
//                         rename while the consultation runs is readable again
//                         -- the kernel drops a bind mount whose file the host
//                         replaces (mount_namespaces(7)), so this holds for
//                         every file-level entry, ~/.claude.json (seen) and
//                         ~/.codex/auth.json on a token refresh alike;
//                         directory entries are not affected. File-name rules
//                         (.env anywhere) cannot be expressed: an unrooted
//                         `**` glob is refused.
//   hooks.enabled=false   no hook inheritance.
//   agents.enabled=false  no sub-agent tools. Codex enables them by default and
//                         --ignore-user-config keeps that default: on
//                         2026-10-17 (codex 0.163) a consultant spawned a
//                         sub-agent without this, and had no spawn tool with it.
//   shell_environment_policy.inherit="core"  child shell gets only the core
//                         variables (PATH, HOME, USER, SHELL, LANG ...), none
//                         of the parent's keys. "none" also dropped PATH, and
//                         every command failed with "cat: command not found"
//                         (seen in consultations on 2026-10-17). `.set` has to
//                         put the recursion marker back: without it, anything Codex launches from
//                         its shell would not see SEVERALLY_ACTIVE=1 and
//                         would not be refused by the guard in server.mjs.
//                         Verified offline against codex 0.153.4:
//                           codex sandbox -c 'shell_environment_policy.inherit="none"' \
//                             -c 'shell_environment_policy.set={SEVERALLY_ACTIVE="1"}' -- env
//                         prints SEVERALLY_ACTIVE=1 and nothing else
//                         inherited (without `.set`, the marker is absent).
//   --ephemeral           the brief is not persisted into the user's session store.
//   tools.web_search=true search/browse stays available (server-side tool).
//                         With the request's network off: tools.web_search=false
//                         plus web_search="disabled" -- codex 0.163 kept
//                         searching with the first alone (2026-10-17). The
//                         read-only sandbox already blocks the shell's network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POLICY, protectedRoots } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';

/** @typedef {import('../run.mjs').BuildRequest} BuildRequest */
/** @typedef {import('../run.mjs').ChildResult} ChildResult */
/** @typedef {import('../run.mjs').Invocation} Invocation */
/** @typedef {import('../run.mjs').Interpreted} Interpreted */
/** @typedef {import('../run.mjs').UsageRecord} UsageRecord */
/** @typedef {import('../run.mjs').Boundary} Boundary */

export const FORBIDDEN_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--add-dir',
  '--approve-for-me',
];

// Refused in the operator's config `args` on top of FORBIDDEN_FLAGS and every
// flag buildInvocation already sets: long aliases of those (so `--sandbox`
// cannot replace the permission profile, nor `--config` any `-c` above), a profile or
// feature switch that could re-enable what --ignore-user-config drops, and
// the modes that leave the read-only sandbox.
export const RESERVED_FLAGS = [
  '-s',
  '--sandbox',
  '--config',
  '--cd',
  '--model',
  '--output-last-message',
  '--profile',
  '-p',
  '--enable',
  '--full-auto',
  '--worktree',
  '--cyber-access-program',
];

const PROFILE = 'severally';

/** @param {string} dir @returns {string[]} */
const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The profile's filesystem table, as TOML: everything readable, the protected
 * roots not. The profile has no wildcard, so a `*` segment (jobs/<id>/home) is
 * expanded to what exists at launch; ~/.codex is listed entry by entry, minus
 * packages/ (see above). Both are snapshots: an entry created after launch is
 * not covered.
 */
export function filesystemPermissions() {
  // A path that does not exist at launch cannot be masked: a homes/<id> made
  // by a concurrent agy or OpenCode consultation was readable (verified).
  fs.mkdirSync(path.join(POLICY.home, 'homes'), { recursive: true, mode: 0o700 });
  const codexHome = path.join(os.homedir(), '.codex').replaceAll('\\', '/');
  const denied = protectedRoots().flatMap((p) => {
    if (p === codexHome)
      return listDir(codexHome)
        .filter((n) => n !== 'packages')
        .map((n) => `${codexHome}/${n}`);
    const star = p.indexOf('/*/');
    if (star === -1) return [p];
    const [parent, rest] = [p.slice(0, star), p.slice(star + 3)];
    return listDir(parent)
      .map((n) => `${parent}/${n}/${rest}`)
      .filter((q) => fs.existsSync(q));
  });
  return `{ ":root" = "read", ${denied.map((p) => `${JSON.stringify(p)} = "none"`).join(', ')} }`;
}

/**
 * @param {BuildRequest} req
 * @returns {Invocation}
 */
export function buildInvocation({ workdir, schemaPath, consultant, network = 'on' }) {
  const t = POLICY.clis.codex;
  const chosen = consultant.model;
  const lastMessagePath = path.join(workdir, '..', 'last-message.json');
  const args = [
    'exec',
    '--json',
    '--color',
    'never',
    '-m',
    chosen,
    '-c',
    `model_reasoning_effort="${consultant.effort ?? 'high'}"`,
    '-c',
    `tools.web_search=${network !== 'off'}`,
    ...(network === 'off' ? ['-c', 'web_search="disabled"'] : []),
    '-c',
    'hooks.enabled=false',
    '-c',
    'agents.enabled=false',
    '-c',
    'shell_environment_policy.inherit="core"',
    '-c',
    'shell_environment_policy.set={SEVERALLY_ACTIVE="1"}',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--ephemeral',
    '-c',
    `default_permissions="${PROFILE}"`,
    '-c',
    `permissions.${PROFILE}.filesystem=${filesystemPermissions()}`,
    '-C',
    workdir,
    '--output-schema',
    schemaPath,
    '-o',
    lastMessagePath,
    '-',
  ];
  return { command: t.cli, args, lastMessagePath, model: chosen };
}

/**
 * One JSONL event from `codex exec --json`, or the item inside it; the CLI
 * controls both, so every field is optional.
 * @typedef {object} CodexItem
 * @property {unknown} [type]
 * @property {unknown} [text]
 * @property {unknown} [message]
 * @property {unknown} [usage]
 * @typedef {CodexItem & { error?: { message?: unknown }, item?: CodexItem }} CodexEvent
 */

/**
 * @param {CodexItem | null | undefined} node
 * @param {Record<string, number>} acc
 * @returns {void}
 */
function walkUsage(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (node.usage && typeof node.usage === 'object') {
    const u = node.usage;
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === 'number') acc[k] = Math.max(acc[k] ?? 0, v);
    }
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') walkUsage(v, acc);
}

/**
 * Parse the JSONL event stream `codex exec --json` writes to stdout.
 * @param {Partial<ChildResult> & { lastMessageText?: string }} run
 * @returns {Interpreted}
 */
export function interpret({ stdout, stderr, code, lastMessageText }) {
  /** @type {CodexEvent[]} */
  const events = [];
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* partial line */
    }
  }

  const errorEvents = events.filter((e) => e.type === 'error' || e.type === 'turn.failed');
  /** @type {Record<string, number>} */
  const usage = {};
  for (const e of events) walkUsage(e, usage);

  let text = (lastMessageText || '').trim();
  if (!text) {
    // Fall back to the last assistant message carried in the event stream.
    for (const e of events.toReversed()) {
      if (text) break;
      const item = e.item ?? e;
      const candidate =
        (item && item.type && String(item.type).includes('agent_message') && (item.text ?? item.message)) ||
        (e.type === 'item.completed' && item && (item.text ?? item.message)) ||
        null;
      if (typeof candidate === 'string' && candidate.trim()) text = candidate.trim();
    }
  }

  const errorMsg = errorEvents.map((e) => e.message ?? e.error?.message ?? JSON.stringify(e)).join(' | ');
  // An error the turn recovered from (the stream still ends in
  // turn.completed, with an answer) does not throw the answer away; the lead
  // is told about it instead. A turn that ends in turn.failed has failed,
  // whatever text it left behind.
  const recovered = errorEvents.length > 0 && Boolean(text) && events.at(-1)?.type === 'turn.completed';
  if (errorEvents.length && !recovered) {
    return { ok: false, failureKind: classifyMessage(errorMsg), message: errorMsg, usageRaw: usage, events: events.length };
  }
  if (!text) {
    const msg = (stderr || '').trim() || `codex exited with code ${code} and produced no final message`;
    return {
      ok: false,
      failureKind: code === 0 ? 'invalid_output' : classifyMessage(msg),
      message: msg,
      usageRaw: usage,
      events: events.length,
    };
  }
  return {
    ok: true,
    text,
    usageRaw: usage,
    events: events.length,
    recoveredError: recovered ? { failureKind: classifyMessage(errorMsg), message: errorMsg } : null,
  };
}

/**
 * What this consultation has done so far. Codex already runs with `exec --json`,
 * so its event stream is there for the reading -- no flag change and no parser
 * change, only a use for events we were otherwise discarding.
 * @param {{ stdout?: string }} run
 * @returns {string | null}
 */
export function progress({ stdout }) {
  const items = [];
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (typeof e?.type === 'string' && e.type.startsWith('item.')) items.push(e);
    } catch {
      /* a partial line, e.g. when the child was killed mid-write */
    }
  }
  if (!items.length) return null;
  const last = items[items.length - 1];
  const kind = last.item?.type ?? last.type;
  return `${items.length} item event(s), last was ${kind}`;
}

/**
 * The calls that can read a file. Codex reads through its shell, and a command
 * that exits non-zero (an rg with no match) still looked, so failed ones count.
 * ponytail: any command counts, an ls as much as a cat, so this catches an
 * answer given without looking at all, not one that skipped a file; telling
 * them apart would mean parsing the command line.
 */
export const FILE_READ_TOOLS = ['command_execution', 'command_execution:error'];

/**
 * Tool calls seen in the event stream, counted by item type (and by tool for
 * MCP and collaboration calls, which is where a sub-agent spawn shows up);
 * `:error` when the item ended failed or declined.
 * @param {{ stdout?: string }} run
 * @returns {Record<string, number>}
 */
export function toolCalls({ stdout }) {
  /** @type {Map<unknown, string>} */
  const seen = new Map();
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    const item = e?.item;
    if (!item?.type || !['item.started', 'item.completed'].includes(e.type)) continue;
    if (['agent_message', 'reasoning', 'error'].includes(item.type)) continue;
    const base = item.tool ? `${item.type}:${item.tool}` : item.type;
    const name = item.status === 'failed' || item.status === 'declined' ? `${base}:error` : base;
    seen.set(item.id ?? `${name}#${seen.size}`, name);
  }
  return [...seen.values()].reduce((/** @type {Record<string, number>} */ o, n) => ({ ...o, [n]: (o[n] ?? 0) + 1 }), {});
}

/**
 * The shell commands the consultant ran, one per item id (a command is
 * reported when it starts and again when it ends), without the `bash -lc`
 * wrapper Codex puts around them. The item's output is never read: it holds
 * the files' contents.
 * @param {{ stdout?: string }} run
 * @returns {string[]}
 */
export function toolInputs({ stdout }) {
  /** @type {Map<unknown, string>} */
  const seen = new Map();
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    const item = e?.item;
    if (item?.type === 'command_execution' && typeof item.command === 'string')
      seen.set(item.id ?? `#${seen.size}`, item.command.replace(/^\/\S*\/(?:ba|z)?sh -lc '([\s\S]*)'$/, '$1'));
  }
  return [...seen.values()];
}

/**
 * @param {unknown} raw the usage figures interpret collected from the event stream
 * @returns {UsageRecord}
 */
export function usageRecord(raw) {
  // interpret's usageRaw is the Record<string, number> walkUsage filled (or null).
  const u = /** @type {Record<string, number>} */ (raw ?? {});
  /** @param {...string} names */
  const pick = (...names) => {
    for (const n of names) {
      const v = u[n];
      if (typeof v === 'number') return v;
    }
    return null;
  };
  return {
    input_tokens: pick('input_tokens', 'prompt_tokens'),
    cached_input_tokens: pick('cached_input_tokens', 'cache_read_input_tokens'),
    output_tokens: pick('output_tokens', 'completion_tokens'),
    total_tokens: pick('total_tokens'),
    cost_usd: null, // Codex CLI does not report a cost; do not guess one.
    web_search_requests: null,
  };
}

/**
 * What this consultant was launched with, read off the invocation: the
 * boundary record kept beside each answer. Facts about the launch, not a
 * claim about what the consultant did.
 * @param {{ args: string[] }} launch
 * @returns {Boundary}
 */
export function boundary({ args }) {
  return {
    reads: 'whole disk except the protected paths (permission profile)',
    shell: 'permission profile: commands run, writes and shell network blocked',
    web: args.includes('tools.web_search=true'),
    writes: false,
    mcp: false,
    protected_paths: args.some((a) => a.startsWith(`permissions.${PROFILE}.filesystem=`))
      ? 'denied by path (permission profile), as the paths stood at launch: ~/.codex entries other than packages/, ' +
        'and legacy job homes, created later are not covered; file names such as .env anywhere are not; on Linux a ' +
        'protected file replaced by rename during the run is readable'
      : 'not enforced',
    tools: null,
  };
}
