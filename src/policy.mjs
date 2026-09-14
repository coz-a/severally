// Server-side policy. Nothing here can be widened by an incoming request:
// every knob is read from the process environment of the MCP server itself
// (i.e. the operator's client config), never from tool arguments.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from './jsonc.mjs';

// One file, read once at start, so an operator configures a machine in a
// single place instead of editing each client's MCP registration. Precedence
// is env > this file > autodetection > built-in default: the env vars stay the
// per-client escape hatch, and a machine that simply lacks a CLI needs no
// configuration at all.
const CONFIG_HOME = process.env.SEVERALLY_HOME || path.join(os.homedir(), '.severally');
// .jsonc first, for operators whose editor treats comments in a .json file as
// an error; both are read the same way, comments and all.
const CONFIG_PATH = process.env.SEVERALLY_CONFIG
  || [path.join(CONFIG_HOME, 'config.jsonc'), path.join(CONFIG_HOME, 'config.json')]
    .find((p) => fs.existsSync(p))
  || path.join(CONFIG_HOME, 'config.json');

let configError = null;
const CONFIG = (() => {
  try {
    return parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    // A missing file is the normal case. A malformed one is not: silently
    // ignoring it would run the machine on defaults the operator thinks they
    // overrode, so it is surfaced on stderr when the server starts.
    if (err.code !== 'ENOENT') configError = `${CONFIG_PATH}: ${err.message}`;
    return {};
  }
})();

/** The config file's parse error, if it had one. Reported at startup. */
export function configProblem() {
  return configError;
}

const cfgTarget = (id) => (CONFIG.targets && typeof CONFIG.targets === 'object' ? CONFIG.targets[id] ?? {} : {});

/**
 * Is this command runnable here? Absolute/relative paths are checked as given.
 * Exported so the config generator can report what a machine has without
 * going through POLICY, which already reflects any config file it found.
 */
export function isInstalled(command) {
  if (typeof command !== 'string' || command === '') return false;
  if (command.includes('/')) return fs.existsSync(command);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch { /* not here */ }
  }
  return false;
}

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

/**
 * A target may carry a model as a suffix: "claude:claude-opus-5". Only the
 * consultant half is spelling-normalised -- a model id is matched against the
 * operator's allowlist verbatim, so its case and dots survive.
 */
export function normalizeTargetSpec(raw) {
  if (typeof raw !== 'string') return raw;
  const at = raw.indexOf(':');
  if (at === -1) return normalizeTargetInput(raw);
  return `${normalizeTargetInput(raw.slice(0, at))}:${raw.slice(at + 1).trim()}`;
}

/** Split "<target>[:<model>]" into its two halves; model is null when absent. */
export function splitTargetSpec(raw) {
  if (typeof raw !== 'string') return { target: raw, model: null };
  const at = raw.indexOf(':');
  if (at === -1) return { target: raw, model: null };
  return { target: raw.slice(0, at), model: raw.slice(at + 1).trim() };
}

/** Canonical id for any accepted spelling of a target, or null. */
export function resolveTarget(raw) {
  const key = normalizeTargetInput(raw);
  if (typeof key !== 'string') return null;
  return Object.hasOwn(TARGET_ALIASES, key) ? TARGET_ALIASES[key] : null;
}

/**
 * Match what the user called a model against the ones the operator allowed
 * for this consultant: "Claude Opus" -> "claude-opus-5". Exact wins; otherwise
 * a unique substring match wins. Two candidates is an error, never a guess --
 * running the wrong model is worse than asking which one was meant.
 *
 * @returns {{model: string} | {ambiguous: string[]} | null} null = no match.
 */
export function resolveModel(target, wanted) {
  const allowed = POLICY.targets[target]?.allowedModels ?? [];
  if (typeof wanted !== 'string' || wanted === '') return null;
  if (allowed.includes(wanted)) return { model: wanted };
  const key = wanted.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const exact = allowed.find((m) => m.toLowerCase() === key);
  if (exact) return { model: exact };
  const hits = allowed.filter((m) => m.toLowerCase().includes(key));
  if (hits.length === 1) return { model: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return null;
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

// What the lead may write against one point of an answer. Four words, chosen so
// that "I have not checked this" is a first-class outcome rather than the
// absence of a record: an unchecked finding and a finding that turned out not
// to apply are different things a month later. The server stores the word and
// counts the words; it never derives one from anything else the lead wrote.
export const VERDICTS = ['unverified', 'confirmed', 'not_applicable', 'unverifiable'];

// The consultant's own one-word bottom line. Also what the lead may predict
// before asking -- the same vocabulary, so a prediction and an answer can be
// read side by side without anyone translating between two scales.
export const STANCES = ['proceed', 'do_not_proceed', 'alternative', 'undetermined'];

// A request may name a model, but only one the operator has listed. The
// default is always allowed; anything else has to be added to the target's
// SEVERALLY_*_ALLOWED_MODELS list, so a runaway caller cannot reach a model the
// operator never sanctioned -- and a typo is refused before a CLI is launched.
const list = (name) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

/**
 * A leading ~ is a shell courtesy, not a path: nothing expands it here, so
 * "~/.local/bin/claudex" would simply not exist and the consultant would drop
 * out of the available list without saying why. Expand it where a path is read.
 */
function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

// env > config file > built-in default, for one target-scoped knob.
const knob = (id, envName, key, dflt) => {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromCfg = cfgTarget(id)[key];
  return typeof fromCfg === 'string' && fromCfg !== '' ? fromCfg : dflt;
};

// The models a request may name (config: allowed_models). The default is always
// allowed, so an operator who configures nothing still has a working -- and
// unchoosable -- default. Named apart from `model`/`default_model` on purpose:
// one letter between "the model it runs" and "the models it may be asked for"
// is a difference a reader will miss.
const allowedFor = (id, dflt, envName) => {
  const fromEnv = list(envName);
  const cfgAllowed = cfgTarget(id).allowed_models;
  const fromCfg = Array.isArray(cfgAllowed) ? cfgAllowed.filter((m) => typeof m === 'string') : [];
  const extra = fromEnv.length ? fromEnv : fromCfg;
  return Object.freeze([...new Set([dflt, ...extra])]);
};

// Enabled targets, in precedence order: SEVERALLY_TARGETS names the whole
// set explicitly; otherwise a per-target `enabled` in the config file decides;
// otherwise the machine does -- a CLI that is not installed is not offered.
const ENABLED_ENV = list('SEVERALLY_TARGETS').map((t) => t.trim().toLowerCase()).filter(Boolean);
// Why a consultant is off, in the operator's words: "quota exhausted until
// 15:00" is more use to a lead than a bare refusal, and it is the reason a CLI
// that IS installed gets excluded.
const disabledNote = (id) => {
  const n = cfgTarget(id).note;
  return typeof n === 'string' && n.trim() !== '' ? n.trim() : null;
};

const isEnabled = (id, cli) => {
  if (ENABLED_ENV.length) return ENABLED_ENV.includes(id);
  const flag = cfgTarget(id).enabled;
  if (typeof flag === 'boolean') return flag;
  return isInstalled(cli);
};

const CODEX_BIN = expandHome(knob('codex', 'SEVERALLY_CODEX_BIN', 'bin', 'codex'));
const CLAUDE_BIN = expandHome(knob('claude-code', 'SEVERALLY_CLAUDE_BIN', 'bin', 'claude'));
const AGY_BIN = expandHome(knob('antigravity', 'SEVERALLY_AGY_BIN', 'bin', 'agy'));

const CODEX_MODEL = knob('codex', 'SEVERALLY_CODEX_MODEL', 'default_model', 'gpt-6-astra');
const CLAUDE_MODEL = knob('claude-code', 'SEVERALLY_CLAUDE_MODEL', 'default_model', 'claude-fable-5-1');
const AGY_MODEL = knob('antigravity', 'SEVERALLY_AGY_MODEL', 'default_model', 'gemini-3.8-flash-high');

export const POLICY = Object.freeze({
  home: str('SEVERALLY_HOME', path.join(os.homedir(), '.severally')),

  targets: Object.freeze({
    codex: Object.freeze({
      cli: CODEX_BIN,
      available: isEnabled('codex', CODEX_BIN),
      note: disabledNote('codex'),
      model: CODEX_MODEL,
      allowedModels: allowedFor('codex', CODEX_MODEL, 'SEVERALLY_CODEX_ALLOWED_MODELS'),
      allowedModelsEnv: 'SEVERALLY_CODEX_ALLOWED_MODELS',
      reasoningEffort: str('SEVERALLY_CODEX_EFFORT', 'medium'),
      label: 'Codex CLI',
      vendor: 'openai',
    }),
    'claude-code': Object.freeze({
      cli: CLAUDE_BIN,
      available: isEnabled('claude-code', CLAUDE_BIN),
      note: disabledNote('claude-code'),
      model: CLAUDE_MODEL,
      allowedModels: allowedFor('claude-code', CLAUDE_MODEL, 'SEVERALLY_CLAUDE_ALLOWED_MODELS'),
      allowedModelsEnv: 'SEVERALLY_CLAUDE_ALLOWED_MODELS',
      label: 'Claude Code CLI',
      vendor: 'anthropic',
      maxBudgetUsd: num('SEVERALLY_CLAUDE_MAX_BUDGET_USD', 2, 0.05, 20),
    }),
    antigravity: Object.freeze({
      cli: AGY_BIN,
      available: isEnabled('antigravity', AGY_BIN),
      note: disabledNote('antigravity'),
      // The model name carries the reasoning effort; agy rejects --effort for it.
      model: AGY_MODEL,
      allowedModels: allowedFor('antigravity', AGY_MODEL, 'SEVERALLY_AGY_ALLOWED_MODELS'),
      allowedModelsEnv: 'SEVERALLY_AGY_ALLOWED_MODELS',
      label: 'Antigravity CLI',
      vendor: 'google',
      // Where the real credentials live is credentialsHome() below, not a
      // field here: the sandbox has to read it per job rather than have it
      // frozen at import (see the note on timeoutMs()).
    }),
  }),

  // Grace period between SIGTERM and SIGKILL of the child process group.
  killGraceMs: num('SEVERALLY_KILL_GRACE_MS', 5_000, 500, 60_000),
  // 1 initial round + 2 follow-ups.
  maxRounds: num('SEVERALLY_MAX_ROUNDS', 3, 1, 5),
  maxConcurrent: num('SEVERALLY_MAX_CONCURRENT', 3, 1, 4),
  maxJobsRetained: num('SEVERALLY_MAX_JOBS_RETAINED', 200, 20, 2000),
  // Upper bound for consult_get(wait_ms). Deliberately under the 60s default
  // request timeout that MCP clients apply, so a long wait does not blow up as
  // a client-side timeout while the consultation is still healthy.
  maxWaitMs: num('SEVERALLY_MAX_WAIT_MS', 45_000, 0, 600_000),

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

const TIMEOUT_ENV = {
  codex: 'SEVERALLY_CODEX_TIMEOUT_MS',
  'claude-code': 'SEVERALLY_CLAUDE_TIMEOUT_MS',
  antigravity: 'SEVERALLY_AGY_TIMEOUT_MS',
};

/**
 * Wall-clock budget for a single consultation, per consultant. Read at job
 * start (not frozen into the module) so an operator restart is not needed to
 * retune it, and per target because they do not take the same time: a long
 * Gemini answer should not force the same patience on every other consultant.
 * The 30 minute ceiling stays -- past that the answer is a different request,
 * not a slower one.
 */
export function timeoutMs(target) {
  const shared = num('SEVERALLY_TIMEOUT_MS', 600_000, 1_000, 1_800_000);
  if (!target || !TIMEOUT_ENV[target]) return shared;
  const fromEnv = num(TIMEOUT_ENV[target], null, 1_000, 1_800_000);
  if (fromEnv !== null) return fromEnv;
  const fromCfg = cfgTarget(target).timeout_ms;
  if (typeof fromCfg === 'number' && Number.isFinite(fromCfg)) {
    return Math.min(1_800_000, Math.max(1_000, fromCfg));
  }
  return shared;
}

/**
 * Where the Antigravity consultant's real credentials live; the per-job
 * sandbox links its token out of this tree. Read at call time for the same
 * reason as timeoutMs(), and defined here so policy.mjs stays the single
 * place an operator knob is spelled out.
 */
export function credentialsHome() {
  return str('SEVERALLY_AGY_CRED_HOME', os.homedir());
}

export const artifactKinds = ['code', 'log', 'doc', 'data', 'diff', 'spec', 'test-output', 'config'];

/**
 * Why this consultant cannot be reached, or null when it can. The operator's
 * own note wins: "installed but rate-limited" is a case only they can state.
 */
export function unavailableReason(id) {
  const t = POLICY.targets[id];
  if (!t || t.available) return null;
  if (t.note) return t.note;
  if (!isInstalled(t.cli)) return `${t.cli} is not installed here`;
  return 'turned off in the operator configuration';
}

/** The consultants this machine can actually reach, in canonical order. */
export function availableTargets() {
  return TARGETS.filter((t) => POLICY.targets[t].available);
}

export function limitsSummary() {
  const models = {};
  for (const t of availableTargets()) models[t] = POLICY.targets[t].model;
  return {
    available_targets: availableTargets(),
    models,
    // Per consultant, because they no longer share one budget.
    timeout_ms: Object.fromEntries(availableTargets().map((t) => [t, timeoutMs(t)])),
    max_rounds_per_chain: POLICY.maxRounds,
    max_concurrent_jobs: POLICY.maxConcurrent,
    max_wait_ms: POLICY.maxWaitMs,
    input_char_budget: POLICY.input.totalCharsMax,
    // Stated so it is true of all three consultants. Reading is allowed for
    // every one of them -- what keeps a consultation brief-only is that the
    // child starts in an empty working directory and is never told where the
    // repository is, not that it cannot read. Codex is additionally sandboxed
    // read-only rather than execution-free, so do not advertise "no execution".
    consultant_permissions:
      'web search/browse and reading local files allowed, but the consultant starts in an empty working ' +
      'directory and is not told where your repository is; file edits, network access, MCP tools and ' +
      'further consultations denied; the Codex consultant additionally has a read-only shell',
  };
}
