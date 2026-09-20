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
//   -m <provider/model>  the model, e.g. zai-coding-plan/glm-5.3
//   --title severally  labels the session inside the ephemeral store
// --pure (1.x: no external plugins) is gone as of opencode 2.0, which rejects
// unknown flags with a usage dump; plugin isolation is the synthesised HOME's
// empty plugin/skill/agent dirs, not a flag.
// The brief goes in on stdin (run reads piped stdin as the prompt), never
// argv: it is long and would otherwise show up in the process list.
//
// Event shapes were verified live against 1.18.31 and re-probed on 2.0.11
// (Linux, glm-5.3): the stdin prompt is read, the answer is still the last
// completed `text` part, and error events moved from {name, data:{message}}
// to {type, message} -- both shapes are parsed, and 2.x exits 0 even on
// provider errors. 1.x step-finish events carry tokens and cost; the 2.x
// one-shot streams observed carried no step-finish at all, so usage degrades
// to nulls rather than a guess.

import { POLICY } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';
import { spawnCommand } from '../platform.mjs';

// Checked against opencode 1.18.31. The list exists so a future edit that
// reaches for one of them is refused rather than quietly widening the
// consultant:
//   --auto / --yolo / --dangerously-skip-permissions  approve what the
//                     sandbox config denies -- the whole isolation in one flag
//   --attach          (1.x) bind to a running server built from the USER's
//                     config, not the sandbox's: MCP servers, plugins and the
//                     real session store all come back. 2.x renamed it.
//   --server          (2.x) connect to a server URL instead of the background
//                     service -- the attach hole under its new name.
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
  '--server',
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

// --standalone (2.x) runs the consultation on a private server instead of
// the shared "background service". The service route is wrong twice for a
// sandboxed one-shot: discovery is not HOME-scoped (the child can end up
// waiting on a service registry it shares with the operator's sessions, and
// a fresh sandbox's own service start was observed hanging for the CLI's
// full two-minute timeout while other opencode services ran), and a private
// server lives and dies with the child's process group. 1.18.31 has no such
// flag (unknown flags die with a usage dump), so support is probed once per
// process through `run --help` and the invocation stays 1.x-exact without it.
let standaloneSupport = null;
let probePromise = null;

/** Probe the CLI's capabilities once per process; safe to call per job. */
export async function prepare() {
  if (standaloneSupport !== null) return;
  if (!probePromise) {
    probePromise = new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; standaloneSupport = Boolean(v); resolve(); } };
      try {
        // The probe inherits the server environment minus the test-suite's
        // STUB_* observables (a stubbed CLI cannot tell it ran), keeping
        // STUB_HELP so a test can still shape the advertised flag list.
        const env = Object.fromEntries(Object.entries(process.env)
          .filter(([k]) => !k.startsWith('STUB_') || k === 'STUB_HELP'));
        const child = spawnCommand(POLICY.targets.opencode.cli, ['run', '--help'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        child.on('error', () => done(false));
        child.on('close', () => done(out.includes('--standalone')));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(false); }, 10_000).unref();
      } catch {
        done(false);
      }
    });
  }
  await probePromise;
}

/** Forget the probe result (tests only; a new prepare() re-probes). */
export async function resetProbe() {
  standaloneSupport = null;
  probePromise = null;
}

/**
 * The 2.x recovery seam. opencode 2.x reads credentials from its session
 * database rather than the copied auth.json, so a sandboxed first run fails
 * with the no-route signature ("Model unavailable: <provider/model>") --
 * having created the database on the way down. When that exact failure
 * meets a model whose provider has a seedable credential (an api entry in
 * the copied auth.json, or a credential row in the operator's own database),
 * the row is written into the sandbox database (see opencode-sandbox.mjs)
 * and the caller retries once. Strictly once per job; every other failure
 * kind -- an auth rejection, a usage limit, invalid output -- means a
 * respawn is wasted compute.
 */
export function recoverAuthFailure({ interpreted, sandbox, model }) {
  if (!interpreted || interpreted.ok !== false || interpreted.failureKind !== 'model_unavailable') return false;
  if (typeof model !== 'string' || !model.includes('/')) return false;
  const provider = model.slice(0, model.indexOf('/'));
  if (!provider) return false;
  return typeof sandbox?.seed === 'function' ? sandbox.seed(provider) : false;
}

export function buildInvocation({ model }) {
  const t = POLICY.targets.opencode;
  // The request may name a model the operator allowed; default otherwise.
  const chosen = model ?? t.model;
  const args = [
    'run',
    '--format', 'json',
    ...(standaloneSupport ? ['--standalone'] : []),
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
  // 2.x: {type, message} -- the message is already a complete human sentence,
  // so it is used verbatim. 1.x: {name, data:{message}} -- the class name and
  // message are joined, as before. A CLI upgrade must degrade the wording and
  // never the classification.
  if (typeof error.message === 'string' && error.message) return error.message;
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
export function interpret({ stdout, stderr, code, truncated = false }) {
  const all = events(stdout);
  let text = null;
  let textIndex = -1;
  let lastErrorIndex = -1;
  let finishedAfterText = false;
  let tokens = null;
  let cost = null;
  let steps = 0;
  const errors = [];
  const earlierTextParts = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    const part = e.part;
    if (e.type === 'text' && part?.type === 'text' && part.time?.end && typeof part.text === 'string' && part.text.trim()) {
      // The last completed part wins as the answer, but every part that had
      // held that title before it is kept: models sometimes append a short
      // prose epilogue after the JSON contract, and the caller can then fall
      // back to the part that actually carries the contract.
      if (text !== null) earlierTextParts.push(text);
      text = part.text.trim();
      textIndex = i;
      // A finish after an EARLIER text part must not vouch for this one:
      // the consultation kept working after that finish, so this part needs
      // its own finish (or an untruncated stream) before it can be trusted.
      finishedAfterText = false;
    } else if (e.type === 'step_finish' && part?.type === 'step-finish') {
      steps += 1;
      if (textIndex !== -1 && i > textIndex) finishedAfterText = true;
      if (part.tokens && typeof part.tokens === 'object') tokens = part.tokens;
      if (typeof part.cost === 'number') cost = part.cost;
    } else if (e.type === 'error' && e.error) {
      errors.push(errorMessage(e.error));
      lastErrorIndex = i;
    }
  }

  const usageRaw = { tokens, cost, steps, events: all.length, truncated: Boolean(truncated) };
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
  if (lastErrorIndex > textIndex) {
    // The error came after the final text part: the answer never followed the
    // failure. What text exists is interim prose, and 2.x exits 0 even on
    // provider errors, so order -- not the exit code -- is what tells this
    // apart from the recovered-retry case below.
    const msg = errors[errors.length - 1];
    return { ok: false, failureKind: classifyMessage(msg), message: msg, usageRaw };
  }
  if (code !== 0) {
    // Both CLI generations exit 0 on every observed success, so a nonzero
    // exit alongside a usable-looking text part means the CLI crashed around
    // it; accepting the text would dress a crashed consultation up as advice.
    const msg = errors.join(' | ')
      || (stderr || '').trim()
      || (stdout || '').trim().slice(0, 2000)
      || `opencode exited with code ${code} after producing an answer`;
    return { ok: false, failureKind: classifyMessage(msg), message: msg, usageRaw };
  }
  if (truncated && !finishedAfterText) {
    // stdout hit the rawCaptureMax before the consultation finished, so the
    // final answer event may never have been read. The text we hold is likely
    // interim prose; returning it as the answer would look like advice that
    // never existed. Fail explicitly instead.
    return {
      ok: false,
      failureKind: 'invalid_output',
      message: 'opencode output was truncated before the consultation finished; no complete answer arrived',
      usageRaw,
    };
  }
  if (errors.length) {
    // An error event followed by a usable answer is a retry the CLI already
    // recovered from; the answer stands, but the record keeps the noise.
    return { ok: true, text, earlierTextParts, usageRaw: { ...usageRaw, errors } };
  }
  return { ok: true, text, earlierTextParts, usageRaw };
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
