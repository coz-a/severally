// Claude Code CLI adapter.
//
// Isolation applied here, not left to the parent's configuration:
//   --restricted            drops the command/code-running tools, ignores user,
//                           project and local settings files (so no inherited
//                           hooks/permissions), refuses bypassPermissions.
//   --tools WebSearch,WebFetch,Read,Glob,Grep  the only tools provisioned.
//                           Read/Glob/Grep are there so that all three
//                           consultants are equal readers -- Codex's sandbox is
//                           read-only rather than execution-free, and a fan-out
//                           whose members can read different amounts is not a
//                           fan-out. --restricted still drops every tool that
//                           runs commands or code, so there is no Write, Edit
//                           or Bash: verified by reading a file in the child.
//   --strict-mcp-config     with no --mcp-config, zero MCP servers load, so the
//                           severally server is not reachable: recursion barrier.
//   --setting-sources ''    belt and braces over --restricted.
//   --disable-slash-commands  no skills, so the severally skill cannot fire.
//   --allowedTools WebSearch,WebFetch  allow rules for the two web tools. Without
//                           them --permission-mode manual asks before every search,
//                           and --permission-prompts none turns that ask into a
//                           denial: the consultant silently had no web at all.
//                           Read/Glob/Grep need no rule (read-only tools).
//   --settings {permissions.deny}  Read rules for PROTECTED_HOME_PATHS and
//                           PROTECTED_FILE_NAMES. Verified 2026-10-17 with
//                           --setting-sources '': Read on a denied path fails,
//                           and Grep leaves the file out.
//   --permission-prompts none  anything that would prompt is denied outright.
//   --no-session-persistence   the brief is not written to the user's session store.

import os from 'node:os';
import { POLICY, PROTECTED_FILE_NAMES, protectedRoots } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';
import { CONSULT_RESULT_SCHEMA } from '../result-schema.mjs';

/** @typedef {import('../run.mjs').BuildRequest} BuildRequest */
/** @typedef {import('../run.mjs').Invocation} Invocation */
/** @typedef {import('../run.mjs').Interpreted} Interpreted */
/** @typedef {import('../run.mjs').UsageRecord} UsageRecord */
/** @typedef {import('../run.mjs').Boundary} Boundary */

// --add-dir is not listed: the adapter passes `--add-dir /` itself, and
// assertNoForbiddenFlags refuses any other value. --restricted confines the
// file tools to the working directories, and without expose_paths that
// directory is empty, so the widening is what keeps this consultant an equal
// reader with Codex (read-only sandbox) and Antigravity (read_file(*)), both
// of which can already reach the whole disk. Verified 2026-09-13: with it,
// Read/Grep outside the workdir succeed; the tool list is unchanged.
// With expose_paths the widening is dropped -- see buildInvocation.
export const FORBIDDEN_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--mcp-config',
  '--plugin-dir',
  '--plugin-url',
];

// Refused in the operator's config `args` on top of FORBIDDEN_FLAGS and every
// flag buildInvocation already sets: long/short aliases of those, and flags
// that would bring back what --restricted and --setting-sources keep out
// (settings, agents, a replaced system prompt, an old session, an IDE or
// browser link, a remote session).
export const RESERVED_FLAGS = [
  '--print',
  '--allowed-tools',
  '--settings',
  '--agent',
  '--agents',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt-file',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--session-id',
  '--fork-session',
  '--from-pr',
  '--teleport',
  '--input-format',
  '--file',
  '--worktree',
  '-w',
  '--tmux',
  '--background',
  '--bg',
  '--chrome',
  '--ide',
  '--remote-control',
  '--cloud',
  '--environment',
  '--desktop',
];

/** Read deny rules for the paths no consultant may read. */
// Claude Code matches Windows paths in POSIX form (C:\\Users -> /c/Users), so
// an absolute rule names the drive that way: //c/Users/..., not //C:/Users/....
export const posixAbsolute = (/** @type {string} */ p) =>
  p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, /** @type {string} */ d) => `/${d.toLowerCase()}`);

export function protectedReadRules() {
  const home = os.homedir().replaceAll('\\', '/');
  const spec = (/** @type {string} */ root) =>
    root.startsWith(`${home}/`) ? `~/${root.slice(home.length + 1)}` : `//${posixAbsolute(root).replace(/^\/+/, '')}`;
  return [
    ...protectedRoots().flatMap((r) => [`Read(${spec(r)})`, `Read(${spec(r)}/**)`]),
    ...PROTECTED_FILE_NAMES.map((n) => `Read(//**/${n})`),
  ];
}

/**
 * @param {BuildRequest} req
 * @returns {Invocation}
 */
export function buildInvocation({ workdir, guardrails, consultant, hasExposedPaths = false, network = 'on' }) {
  const t = POLICY.clis['claude-code'];
  const chosen = consultant.model;
  const web = network !== 'off';
  const args = [
    '-p',
    '--model',
    chosen,
    '--effort',
    consultant.effort ?? 'high',
    '--restricted',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--tools',
    web ? 'WebSearch,WebFetch,Read,Glob,Grep' : 'Read,Glob,Grep',
    ...(web ? ['--allowedTools', 'WebSearch,WebFetch'] : []),
    '--settings',
    JSON.stringify({ permissions: { deny: protectedReadRules() } }),
    // When the lead has exposed paths, they are already copied into the
    // working directory --restricted confines the file tools to, and the
    // lead has said what this consultation may see. Widening to the whole
    // disk on top of that would contradict the scope it just drew, so the
    // flag goes. Equal-reader parity is not lost: what every consultant now
    // has is the same copied tree, which is the material that exists.
    ...(hasExposedPaths ? [] : ['--add-dir', '/']),
    '--permission-prompts',
    'none',
    '--permission-mode',
    'manual',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(CONSULT_RESULT_SCHEMA),
    '--max-budget-usd',
    String(consultant.maxBudgetUsd ?? 10),
    '--append-system-prompt',
    guardrails,
  ];
  return { command: t.cli, args, model: chosen, workdir };
}

/**
 * The result JSON the CLI prints; the CLI controls it, so every field is optional.
 * @typedef {object} ClaudeResult
 * @property {unknown} [is_error]
 * @property {unknown} [result]
 * @property {string | Record<string, unknown>} [structured_output]
 * @property {string | Record<string, unknown>} [structuredOutput]
 * @property {unknown[]} [permission_denials]
 * @property {{ input_tokens?: unknown, cache_read_input_tokens?: unknown, output_tokens?: unknown, server_tool_use?: { web_search_requests?: unknown } }} [usage]
 * @property {unknown} [total_cost_usd]
 * @property {unknown} [num_turns]
 */

/**
 * @param {string} [stdout]
 * @returns {ClaudeResult | null}
 */
function lastJsonObject(stdout) {
  const lines = (stdout || '').split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* not the result line */
    }
  }
  return null;
}

/**
 * @param {{ stdout?: string, stderr?: string, code?: number | null }} run
 * @returns {Interpreted}
 */
export function interpret({ stdout, stderr, code }) {
  const payload = lastJsonObject(stdout);
  if (!payload) {
    const msg =
      (stderr || '').trim() ||
      (stdout || '').trim().slice(0, 2000) ||
      `claude exited with code ${code} and produced no JSON result`;
    return {
      ok: false,
      failureKind: code === 0 ? 'invalid_output' : classifyMessage(msg),
      message: msg,
      payload: null,
      usageRaw: null,
    };
  }
  if (payload.is_error) {
    const msg = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload).slice(0, 2000);
    return { ok: false, failureKind: classifyMessage(msg), message: msg, payload, usageRaw: payload };
  }
  const structured = payload.structured_output ?? payload.structuredOutput ?? null;
  const text = structured ?? (typeof payload.result === 'string' ? payload.result : null);
  if (!text) {
    return {
      ok: false,
      failureKind: 'invalid_output',
      message: 'result payload contained no answer',
      payload,
      usageRaw: payload,
    };
  }
  return { ok: true, text, payload, usageRaw: payload, denials: payload.permission_denials ?? [] };
}

/**
 * @param {unknown} raw the CLI's result JSON, as interpret kept it
 * @returns {UsageRecord | null}
 */
export function usageRecord(raw) {
  // interpret's usageRaw is the ClaudeResult it parsed (or null).
  const payload = /** @type {ClaudeResult | null} */ (raw);
  if (!payload) return null;
  const u = payload.usage ?? {};
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' ? v : null);
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(u.cache_read_input_tokens),
    output_tokens: num(u.output_tokens),
    total_tokens: null,
    cost_usd: num(payload.total_cost_usd),
    web_search_requests: num(u.server_tool_use?.web_search_requests),
    turns: num(payload.num_turns),
  };
}

/**
 * What this consultant was launched with, read off the invocation: the
 * boundary record kept beside each answer. Facts about the launch, not a
 * claim about what the consultant did.
 * @param {{ args: string[], hasExposedPaths?: boolean }} req
 * @returns {Boundary}
 */
export function boundary({ args, hasExposedPaths }) {
  // buildInvocation always passes --tools with a value.
  const tools = /** @type {string} */ (args[args.indexOf('--tools') + 1]);
  return {
    reads: hasExposedPaths ? 'the exposed copy only' : 'whole disk',
    shell: 'none',
    web: tools.split(',').includes('WebFetch'),
    writes: false,
    mcp: false,
    protected_paths: 'denied (permission rules)',
    tools: tools.split(','),
  };
}
