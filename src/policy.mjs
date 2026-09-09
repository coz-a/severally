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

export const TARGETS = ['codex', 'claude-code'];
export const MODES = ['explore', 'review', 'debate'];

export const POLICY = Object.freeze({
  home: str('PEER_CONSULT_HOME', path.join(os.homedir(), '.peer-consult')),

  targets: Object.freeze({
    codex: Object.freeze({
      cli: str('PEER_CONSULT_CODEX_BIN', 'codex'),
      model: str('PEER_CONSULT_CODEX_MODEL', 'gpt-6-astra'),
      reasoningEffort: str('PEER_CONSULT_CODEX_EFFORT', 'medium'),
      label: 'Codex CLI',
    }),
    'claude-code': Object.freeze({
      cli: str('PEER_CONSULT_CLAUDE_BIN', 'claude'),
      model: str('PEER_CONSULT_CLAUDE_MODEL', 'claude-fable-5-1'),
      label: 'Claude Code CLI',
      maxBudgetUsd: num('PEER_CONSULT_CLAUDE_MAX_BUDGET_USD', 2, 0.05, 20),
    }),
  }),

  // Grace period between SIGTERM and SIGKILL of the child process group.
  killGraceMs: num('PEER_CONSULT_KILL_GRACE_MS', 5_000, 500, 60_000),
  // 1 initial round + 2 follow-ups.
  maxRounds: num('PEER_CONSULT_MAX_ROUNDS', 3, 1, 5),
  maxConcurrent: num('PEER_CONSULT_MAX_CONCURRENT', 2, 1, 4),
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

export const artifactKinds = ['code', 'log', 'doc', 'data', 'diff', 'spec', 'test-output', 'config'];

export function limitsSummary() {
  return {
    models: {
      codex: POLICY.targets.codex.model,
      'claude-code': POLICY.targets['claude-code'].model,
    },
    timeout_ms: timeoutMs(),
    max_rounds_per_chain: POLICY.maxRounds,
    max_concurrent_jobs: POLICY.maxConcurrent,
    max_wait_ms: POLICY.maxWaitMs,
    input_char_budget: POLICY.input.totalCharsMax,
    consultant_permissions: 'web search/browse allowed; file edits, shell execution, and further consultations denied',
  };
}
