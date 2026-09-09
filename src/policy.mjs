// Server-side policy. Nothing here can be widened by an incoming request:
// every knob is read from the process environment of the MCP server itself
// (i.e. the operator's client config), never from tool arguments.

import os from 'node:os';
import path from 'node:path';

const num = (name, dflt, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, v));
};

const str = (name, dflt) => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? dflt : raw;
};

export const TARGETS = ['codex', 'claude-code', 'antigravity'];

// Input aliases. The canonical ids above are what the rest of the server uses;
// these are accepted at the tool boundary only, so a lead can say "gpt" or
// "gemini" and reach the right consultant.
// Object.create(null) so a request cannot reach Object.prototype through the
// alias table: resolveTarget('constructor') must be an unknown target, not
// Object.prototype.constructor.
const TARGET_ALIASES = Object.freeze(Object.assign(Object.create(null), {
  codex: 'codex',
  gpt: 'codex',
  chatgpt: 'codex',
  openai: 'codex',
  'claude-code': 'claude-code',
  claude: 'claude-code',
  anthropic: 'claude-code',
  antigravity: 'antigravity',
  agy: 'antigravity',
  gemini: 'antigravity',
  google: 'antigravity',
}));

export const TARGET_INPUTS = Object.freeze(Object.keys(TARGET_ALIASES));

/**
 * The one spelling-normaliser for a target-like input: case, spaces and
 * underscores are folded away. Exported because schema.mjs needs the identical
 * rule in its zod preprocessor -- two copies of it would drift, and a drift
 * makes resolveTarget() return null for a value the schema has already
 * accepted.
 */
export function normalizeTargetInput(raw) {
  if (typeof raw !== 'string') return raw;
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Canonical id for any accepted spelling of a target, or null. */
export function resolveTarget(raw) {
  const key = normalizeTargetInput(raw);
  if (typeof key !== 'string') return null;
  return Object.hasOwn(TARGET_ALIASES, key) ? TARGET_ALIASES[key] : null;
}

// Which CLI is hosting this server. Used only to annotate a consultation that
// goes to the caller's own vendor; it never affects permissions or limits.
export function detectCaller(env = process.env) {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return 'codex';
  if (Object.keys(env).some((k) => k.startsWith('AGY_') || k.startsWith('ANTIGRAVITY_'))) return 'antigravity';
  return null;
}

export const MODES = ['explore', 'review', 'debate'];

export const POLICY = Object.freeze({
  home: str('PEER_CONSULT_HOME', path.join(os.homedir(), '.peer-consult')),

  targets: Object.freeze({
    codex: Object.freeze({
      cli: str('PEER_CONSULT_CODEX_BIN', 'codex'),
      model: str('PEER_CONSULT_CODEX_MODEL', 'gpt-6-astra'),
      reasoningEffort: str('PEER_CONSULT_CODEX_EFFORT', 'medium'),
      label: 'Codex CLI',
      vendor: 'openai',
    }),
    'claude-code': Object.freeze({
      cli: str('PEER_CONSULT_CLAUDE_BIN', 'claude'),
      model: str('PEER_CONSULT_CLAUDE_MODEL', 'claude-fable-5-1'),
      label: 'Claude Code CLI',
      vendor: 'anthropic',
      maxBudgetUsd: num('PEER_CONSULT_CLAUDE_MAX_BUDGET_USD', 2, 0.05, 20),
    }),
    antigravity: Object.freeze({
      cli: str('PEER_CONSULT_AGY_BIN', 'agy'),
      // The model name carries the reasoning effort; agy rejects --effort for it.
      model: str('PEER_CONSULT_AGY_MODEL', 'gemini-3.8-flash-high'),
      label: 'Antigravity CLI',
      vendor: 'google',
      // Where the real credentials live is credentialsHome() below, not a
      // field here: the sandbox has to read it per job rather than have it
      // frozen at import (see the note on timeoutMs()).
    }),
  }),

  // Grace period between SIGTERM and SIGKILL of the child process group.
  killGraceMs: num('PEER_CONSULT_KILL_GRACE_MS', 5_000, 500, 60_000),
  // 1 initial round + 2 follow-ups.
  maxRounds: num('PEER_CONSULT_MAX_ROUNDS', 3, 1, 5),
  maxConcurrent: num('PEER_CONSULT_MAX_CONCURRENT', 3, 1, 4),
  maxJobsRetained: num('PEER_CONSULT_MAX_JOBS_RETAINED', 200, 20, 2000),
  // Upper bound for consult_get(wait_ms). Deliberately under the 60s default
  // request timeout that MCP clients apply, so a long wait does not blow up as
  // a client-side timeout while the consultation is still healthy.
  maxWaitMs: num('PEER_CONSULT_MAX_WAIT_MS', 45_000, 0, 600_000),

  input: Object.freeze({
    questionMax: 4_000,
    objectiveMax: 4_000,
    proposalMax: 20_000,
    constraintMax: 1_000,
    constraintsMax: 20,
    factMax: 6_000,
    factsMax: 40,
    counterpointMax: 4_000,
    counterpointsMax: 20,
    artifactsMax: 10,
    artifactExcerptMax: 20_000,
    artifactNameMax: 200,
    totalCharsMax: 120_000,
  }),

  output: Object.freeze({
    // Raw child stdout/stderr kept per stream before truncation.
    rawCaptureMax: 400_000,
    summaryMax: 8_000,
    itemTextMax: 4_000,
    listMax: 30,
    referencesMax: 40,
  }),
});

// Wall-clock budget for a single consultation. Read at job start (not frozen
// into the module) so an operator restart is not needed to retune it.
export function timeoutMs() {
  return num('PEER_CONSULT_TIMEOUT_MS', 600_000, 1_000, 1_800_000);
}

/**
 * Where the Antigravity consultant's real credentials live; the per-job
 * sandbox links its token out of this tree. Read at call time for the same
 * reason as timeoutMs(), and defined here so policy.mjs stays the single
 * place an operator knob is spelled out.
 */
export function credentialsHome() {
  return str('PEER_CONSULT_AGY_CRED_HOME', os.homedir());
}

export const artifactKinds = ['code', 'log', 'doc', 'data', 'diff', 'spec', 'test-output', 'config'];

export function limitsSummary() {
  const models = {};
  for (const t of TARGETS) models[t] = POLICY.targets[t].model;
  return {
    models,
    timeout_ms: timeoutMs(),
    max_rounds_per_chain: POLICY.maxRounds,
    max_concurrent_jobs: POLICY.maxConcurrent,
    max_wait_ms: POLICY.maxWaitMs,
    input_char_budget: POLICY.input.totalCharsMax,
    // Stated so it is true of all three consultants. Codex is sandboxed
    // read-only rather than execution-free: `-s read-only` blocks writes and
    // network but not the shell itself, so do not advertise "no execution".
    consultant_permissions:
      'web search/browse allowed; file edits, network access, MCP tools and further consultations denied; ' +
      'the Codex consultant may still run read-only shell commands',
  };
}
