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

import { POLICY, timeoutMs } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';

export { prepareSandbox } from './antigravity-sandbox.mjs';

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

export function buildInvocation({ schemaPath, model }) {
  const t = POLICY.targets.antigravity;
  const chosen = model ?? t.model;
  // stream-json rather than json: the same final envelope arrives as the last
  // `result` event, and the `step_update` events before it are the only record
  // of what a consultation was doing when its budget ran out.
  //
  // --print-timeout gets a margin over our own budget on purpose. With both set
  // to the same value, whichever fired first was a race, and agy winning meant
  // no envelope at all -- reported as invalid_output rather than as the timeout
  // it was. Ours has to fire first for the failure to be classified honestly.
  const budget = timeoutMs('antigravity');
  const args = [
    '--output-format', 'stream-json',
    '--json-schema', schemaPath,
    '--disable-slash-commands',
    '--model', chosen,
    '--print-timeout', `${Math.ceil((budget + 30_000) / 1000)}s`,
  ];
  return { command: t.cli, args, model: chosen };
}

/** Every complete NDJSON object agy wrote, oldest first. */
function events(stdout) {
  const out = [];
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch { /* a partial line, e.g. when the child was killed mid-write */ }
  }
  return out;
}

/**
 * The final envelope: the `result` event under stream-json, or a bare envelope
 * when agy was run with --output-format json (as older configs and the unit
 * tests do).
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
 * What the consultation had done when it was stopped. Only useful on a
 * timeout: it separates "was working steadily and needed longer" from "was
 * stuck on one tool call", which is the difference between raising the budget
 * and narrowing the brief.
 */
export function progressSummary({ stdout }) {
  const steps = events(stdout).filter((e) => e.event === 'step_update' && e.step_update);
  if (!steps.length) return null;
  const last = steps[steps.length - 1].step_update;
  const seen = new Set(steps.map((s) => s.step_update.step_index)).size;
  const what = last.tool_name ? `tool ${last.tool_name}` : (last.step_type ?? 'a step');
  return `no answer was produced; it was still working when the budget ran out: `
    + `${seen} step(s), last was ${what} (${last.state ?? 'state unknown'})`;
}

export function interpret({ stdout, stderr, code }) {
  const payload = finalEnvelope(stdout);
  if (!payload) {
    const msg = (stderr || '').trim() || (stdout || '').trim().slice(0, 2000) ||
      `agy exited with code ${code} and produced no JSON envelope`;
    return { ok: false, failureKind: code === 0 ? 'invalid_output' : classifyMessage(msg), message: msg, usageRaw: null };
  }
  if (payload.status && payload.status !== 'SUCCESS') {
    const msg = typeof payload.error === 'string' && payload.error.trim()
      ? payload.error
      : JSON.stringify(payload).slice(0, 2000);
    return { ok: false, failureKind: classifyMessage(msg), message: msg, usageRaw: payload };
  }
  const structured = payload.structured_output ?? null;
  const text = structured ?? (typeof payload.response === 'string' && payload.response.trim() ? payload.response : null);
  if (!text) {
    return { ok: false, failureKind: 'invalid_output', message: 'envelope contained no answer', usageRaw: payload };
  }
  return { ok: true, text, usageRaw: payload, denials: payload.denied_actions ?? [] };
}

export function usageRecord(payload) {
  if (!payload) return null;
  const u = payload.usage ?? {};
  const num = (v) => (typeof v === 'number' ? v : null);
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
      ? payload.denied_actions.map((d) => d?.action).filter(Boolean)
      : null,
  };
}
