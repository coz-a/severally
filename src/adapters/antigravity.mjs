// Antigravity CLI (agy) adapter.
//
// Isolation is not expressible in flags here, so it lives in
// antigravity-sandbox.mjs: the child gets a synthesised HOME with zero MCP
// servers (recursion barrier) and permission rules that deny writes, shell
// commands, MCP tools and page interaction while leaving search_web and
// read_url available. What the flags below add:
//   --output-format json      one machine-readable envelope on stdout
//   --json-schema <file>      the answer comes back in structured_output
//   --disable-slash-commands  no slash commands or skills in print mode
//   --model <slug>            effort is part of the slug; --effort is rejected
//   --print-timeout           agy's own 5m default is shorter than our budget
// The brief goes in on stdin, never argv: it is long and would otherwise show
// up in the process list.

import fs from 'node:fs';
import path from 'node:path';
import { POLICY, agyExitGraceMs, timeoutMs } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';

export { prepareSandbox } from './antigravity-sandbox.mjs';

/** @typedef {import('../run.mjs').BuildRequest} BuildRequest */
/** @typedef {import('../run.mjs').Invocation} Invocation */
/** @typedef {import('../run.mjs').Interpreted} Interpreted */

// Checked against `agy --help` at 1.1.28. These are inert in print mode as the
// adapter builds it today; the list exists so a future edit that reaches for
// one of them is refused rather than quietly widening the consultant.
export const FORBIDDEN_FLAGS = [
  '--dangerously-skip-permissions',
  '--add-dir',
  '--new-project',
  // `--mode accept-edits` exists to widen the permission posture; `plan` is
  // the only other value, and neither belongs in a consultation.
  '--mode',
  // A named agent brings its own tools and instructions, which is exactly the
  // configuration the synthesised HOME is there to keep out.
  '--agent',
  // `--input-format stream-json` turns print mode into a multi-turn injection
  // channel; the brief is one turn on stdin.
  '--input-format',
  // Each consultation must be a fresh session; these would attach to an old one.
  '--continue',
  '-c',
  '--conversation',
  '--prompt-interactive',
  '-i',
];

// Refused in the operator's config `args` on top of FORBIDDEN_FLAGS and every
// flag buildInvocation already sets: the print-mode aliases, a project that
// brings its own configuration, and a remote connection.
// --effort too: the effort is chosen through the model name, in one place.
export const RESERVED_FLAGS = ['--print', '-p', '--prompt', '--project', '--remote-control', '--effort'];

/**
 * @param {BuildRequest} req
 * @returns {Invocation}
 */
export function buildInvocation({ schemaPath, consultant }) {
  const t = POLICY.clis.antigravity;
  const chosen = consultant.model;
  // stream-json rather than json: the same final envelope arrives as the last
  // `result` event, and the `step_update` events before it are the only record
  // of what a consultation was doing when its budget ran out.
  //
  // --print-timeout gets a margin over our own budget on purpose. With both set
  // to the same value, whichever fired first was a race, and agy winning meant
  // no envelope at all -- reported as invalid_output rather than as the timeout
  // it was. Ours has to fire first for the failure to be classified honestly.
  const budget = timeoutMs(consultant);
  const args = [
    '--output-format',
    'stream-json',
    '--json-schema',
    schemaPath,
    '--disable-slash-commands',
    '--model',
    chosen,
    '--print-timeout',
    `${Math.ceil((budget + 30_000) / 1000)}s`,
  ];
  return { command: t.cli, args, model: chosen };
}

/**
 * Every complete NDJSON object agy wrote, oldest first.
 * @param {string} [stdout]
 * @returns {any[]}
 */
function events(stdout) {
  const out = [];
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      /* a partial line, e.g. when the child was killed mid-write */
    }
  }
  return out;
}

/**
 * The final envelope: the `result` event under stream-json, or a bare envelope
 * when agy was run with --output-format json (as older configs and the unit
 * tests do).
 * @param {string} [stdout]
 * @returns {any}
 */
function finalEnvelope(stdout) {
  const all = events(stdout);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.event === 'result' && e.result && typeof e.result === 'object') return e.result;
    if (e.event === undefined && (e.status || e.response || e.structured_output)) return e;
  }
  return null;
}

/**
 * What this consultation has done so far -- read while it runs, and again when
 * it is killed. It separates "working steadily, needs longer" from "stuck on
 * one tool call", which is the difference between raising the budget and
 * narrowing the brief; and it lets the lead cut a heavy consultation short
 * instead of waiting out the whole budget for nothing.
 * @param {{ stdout: string }} run
 * @returns {string | null}
 */
export function progress({ stdout }) {
  const steps = events(stdout).filter((e) => e.event === 'step_update' && e.step_update);
  if (!steps.length) return null;
  const last = steps[steps.length - 1].step_update;
  const seen = new Set(steps.map((s) => s.step_update.step_index)).size;
  const what = last.tool_name ? `tool ${last.tool_name}` : (last.step_type ?? 'a step');
  return `${seen} step(s), last was ${what} (${last.state ?? 'state unknown'})`;
}

/**
 * Tool calls seen in the step stream, one per step index; `:error` when the step failed or was refused.
 * @param {{ stdout: string }} run
 * @returns {Record<string, number>}
 */
export function toolCalls({ stdout }) {
  const seen = new Map();
  for (const e of events(stdout)) {
    const s = e.event === 'step_update' ? e.step_update : null;
    if (s?.tool_name)
      seen.set(s.step_index ?? seen.size, /error|fail|cancel|denied/i.test(s.state ?? '') ? `${s.tool_name}:error` : s.tool_name);
  }
  return [...seen.values()].reduce((o, n) => ({ ...o, [n]: (o[n] ?? 0) + 1 }), {});
}

/**
 * How long agy may linger after this line, or null. On 2026-10-19
 * (job_790a7173c16d) agy wrote its finish step and then stayed alive for six
 * minutes; the server waits for the process to close, so without this the
 * consultation would have sat "running" until its budget ran out.
 * @param {string} line
 * @returns {number | null}
 */
export function settleAfter(line) {
  if (!line.includes('"result"') && !line.includes('"finish"')) return null;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e?.event === 'result') return agyExitGraceMs().afterResult;
  if (e?.event === 'step_update' && e.step_update?.step_type === 'finish') return agyExitGraceMs().afterFinish;
  return null;
}

// agy is a Go binary: SIGQUIT makes it write every goroutine's stack before it
// exits, which says what it was waiting on. agy 1.1.28 sends its stderr to its
// own log, so the dump lands there rather than in the pipe (checked 2026-10-19).
export const stopSignal = 'SIGQUIT';

/**
 * What to keep when agy did not end on its own: its own log, which holds the
 * goroutine dump and is written inside the sandbox HOME that is removed when
 * the consultation ends, and whatever reached the stderr pipe. Not redacted
 * here; the caller does that.
 * @param {{ run: import('../run.mjs').ChildResult, sandbox: { root: string } }} args
 */
export function diagnostics({ run, sandbox }) {
  const tail = (/** @type {unknown} */ s) => String(s ?? '').slice(-200_000);
  const dir = path.join(sandbox.root, '.gemini', 'antigravity-cli', 'log');
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    /* agy wrote no log */
  }
  return [
    `--- agy stderr ---\n${tail(run.stderr)}`,
    ...names.map((n) => {
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, n), 'utf8');
      } catch {
        /* unreadable */
      }
      return `--- ${n} ---\n${tail(text)}`;
    }),
  ].join('\n');
}

/**
 * @param {{ stdout?: string, stderr?: string, code?: number | null }} run
 * @returns {Interpreted}
 */
export function interpret({ stdout, stderr, code }) {
  const payload = finalEnvelope(stdout);
  if (!payload) {
    const msg =
      (stderr || '').trim() ||
      (stdout || '').trim().slice(0, 2000) ||
      `agy exited with code ${code} and produced no JSON envelope`;
    return { ok: false, failureKind: code === 0 ? 'invalid_output' : classifyMessage(msg), message: msg, usageRaw: null };
  }
  if (payload.status && payload.status !== 'SUCCESS') {
    const msg =
      typeof payload.error === 'string' && payload.error.trim() ? payload.error : JSON.stringify(payload).slice(0, 2000);
    return { ok: false, failureKind: classifyMessage(msg), message: msg, usageRaw: payload };
  }
  const structured = payload.structured_output ?? null;
  const text = structured ?? (typeof payload.response === 'string' && payload.response.trim() ? payload.response : null);
  if (!text) {
    return { ok: false, failureKind: 'invalid_output', message: 'envelope contained no answer', usageRaw: payload };
  }
  return { ok: true, text, usageRaw: payload, denials: payload.denied_actions ?? [] };
}

/** @param {any} payload */
export function usageRecord(payload) {
  if (!payload) return null;
  const u = payload.usage ?? {};
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' ? v : null);
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(u.cache_read_tokens),
    output_tokens: num(u.output_tokens),
    total_tokens: num(u.total_tokens),
    cost_usd: null, // agy does not report a cost; do not guess one.
    web_search_requests: null,
    thinking_tokens: num(u.thinking_tokens),
    turns: num(payload.num_turns),
    // Which permissions the sandbox refused. A denied read_url usually explains
    // a thin evidence basis, so it is worth keeping in the record.
    denied_actions: Array.isArray(payload.denied_actions)
      ? payload.denied_actions.map((/** @type {any} */ d) => d?.action).filter(Boolean)
      : null,
  };
}

/**
 * What this consultant was launched with, read off the invocation: the
 * boundary record kept beside each answer. Facts about the launch, not a
 * claim about what the consultant did.
 * @param {{ sandbox: { tools: readonly string[] } }} req
 */
export function boundary({ sandbox }) {
  return {
    reads: 'whole disk',
    shell: 'none',
    web: sandbox.tools.includes('search_web'),
    writes: false,
    mcp: false,
    protected_paths: 'denied (tool hook)',
    tools: [...sandbox.tools],
  };
}
