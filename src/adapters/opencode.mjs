// OpenCode CLI adapter.
//
// The isolation does not live in flags here, so it lives in
// opencode-sandbox.mjs: the child gets a synthesised HOME whose opencode
// content is exactly one config we wrote (write/bash/task denied, read and
// web allowed, zero MCP servers) plus a linked auth.json. What the flags
// below add:
//   run               non-interactive mode: one prompt, then exit
//   --format json     raw JSON events on stdout; the answer is the last
//                     completed `text` event. There is no --json-schema
//                     equivalent, so the structured answer rides on the
//                     brief's output contract and parse-result's extractJson
//   --pure            no external plugins even if a future version finds a
//                     way to load one
//   -m <provider/model>  the model, e.g. zai-coding-plan/glm-5.3
//   --title severally  labels the session inside the ephemeral store
// The brief goes in on stdin (run reads piped stdin as the prompt), never
// argv: it is long and would otherwise show up in the process list.
//
// Verified live against opencode 1.18.31 on Linux (glm-5.3): the stdin prompt
// is read, the event stream matches the shapes below, the step-finish part
// carries tokens {total, input, output, reasoning, cache:{read, write}} and a
// numeric cost, the sandbox's deny rules leave the consultant exactly
// read+web (its own report: "no file-write or bash tools available"), and no
// session reaches the real ~/.local/share/opencode store.

import { POLICY } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';

// Checked against opencode 1.18.31. The list exists so a future edit that
// reaches for one of them is refused rather than quietly widening the
// consultant:
//   --auto / --yolo / --dangerously-skip-permissions  approve what the
//                     sandbox config denies -- the whole isolation in one flag
//   --attach          bind to a running server built from the USER's config,
//                     not the sandbox's: MCP servers, plugins and the real
//                     session store all come back
//   --continue / --session / --fork  each consultation must be a fresh
//                     session; these attach to an old one
//   --share           uploads the session
//   --agent           a named agent brings its own prompt, tools and
//                     permissions, which is exactly what the synthesised HOME
//                     is there to keep out
//   --command         runs a stored command template with its own instructions
//   --file            attaches local file content to the message
//   --interactive / --mini  TUI modes; break the one-shot event stream
export const FORBIDDEN_FLAGS = [
  '--auto',
  '--yolo',
  '--dangerously-skip-permissions',
  '--attach',
  '--continue',
  '-c',
  '--session',
  '-s',
  '--fork',
  '--share',
  '--agent',
  '--command',
  '--file',
  '-f',
  '--interactive',
  '-i',
  '--mini',
  '--demo',
];

export { prepareSandbox } from './opencode-sandbox.mjs';

export function buildInvocation({ model }) {
  const t = POLICY.targets.opencode;
  // The request may name a model the operator allowed; default otherwise.
  const chosen = model ?? t.model;
  const args = [
    'run',
    '--format', 'json',
    '--pure',
    '-m', chosen,
    '--title', 'severally',
  ];
  return { command: t.cli, args, model: chosen };
}

/** Every complete NDJSON object opencode wrote to stdout, oldest first. */
export function events(stdout) {
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

/** One line naming the error opencode reported, in classifyMessage's terms. */
function errorMessage(error) {
  if (!error || typeof error !== 'object') return JSON.stringify(error);
  const detail = error.data && typeof error.data === 'object' && error.data.message
    ? String(error.data.message)
    : '';
  return [error.name, detail].filter(Boolean).join(': ') || JSON.stringify(error);
}

/**
 * Parse the event stream `opencode run --format json` writes to stdout.
 * The answer is the LAST completed text part: a consultation can emit prose
 * between tool calls, and only the final part carries the reply contract.
 */
export function interpret({ stdout, stderr, code }) {
  const all = events(stdout);
  let text = null;
  let tokens = null;
  let cost = null;
  let steps = 0;
  const errors = [];
  for (const e of all) {
    const part = e.part;
    if (e.type === 'text' && part?.type === 'text' && part.time?.end && typeof part.text === 'string' && part.text.trim()) {
      text = part.text.trim();
    } else if (e.type === 'step_finish' && part?.type === 'step-finish') {
      steps += 1;
      if (part.tokens && typeof part.tokens === 'object') tokens = part.tokens;
      if (typeof part.cost === 'number') cost = part.cost;
    } else if (e.type === 'error' && e.error) {
      errors.push(errorMessage(e.error));
    }
  }

  const usageRaw = { tokens, cost, steps, events: all.length };
  if (!text) {
    const msg = errors.join(' | ')
      || (stderr || '').trim()
      || (stdout || '').trim().slice(0, 2000)
      || `opencode exited with code ${code} and produced no answer`;
    return {
      ok: false,
      failureKind: errors.length || code !== 0 ? classifyMessage(msg) : 'invalid_output',
      message: msg,
      usageRaw,
    };
  }
  if (errors.length) {
    // An error event followed by a usable answer is a retry the CLI already
    // recovered from; the answer stands, but the record keeps the noise.
    return { ok: true, text, usageRaw: { ...usageRaw, errors } };
  }
  return { ok: true, text, usageRaw };
}

/**
 * What this consultation has done so far -- read while it runs. Separates
 * "working steadily through tool calls" from "wedged on one call", which is
 * the difference between raising the budget and narrowing the brief.
 */
export function progress({ stdout }) {
  const seen = events(stdout).filter((e) => ['step_start', 'step_finish', 'text', 'tool_use'].includes(e.type));
  if (!seen.length) return null;
  const last = seen[seen.length - 1];
  const what = last.type === 'tool_use' && last.part?.tool ? `tool ${last.part.tool}` : last.type;
  return `${seen.length} event(s), last was ${what}`;
}

export function usageRecord(raw) {
  const r = raw ?? {};
  const t = r.tokens && typeof r.tokens === 'object' ? r.tokens : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {};
  return {
    input_tokens: num(t.input),
    cached_input_tokens: num(t.cache_read) ?? num(cache.read),
    output_tokens: num(t.output),
    total_tokens: num(t.total),
    cost_usd: num(r.cost),
    web_search_requests: null, // opencode does not report a per-tool count; do not guess one.
    reasoning_tokens: num(t.reasoning),
    turns: num(r.steps),
  };
}
