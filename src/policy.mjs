// Server-side policy. Nothing here can be widened by an incoming request:
// every knob is read from the process environment of the MCP server itself
// (i.e. the operator's client config), never from tool arguments.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from './jsonc.mjs';
import { findCommand } from './platform.mjs';
import { buildConsultants, CLI_IDS, normalizeName } from './consultants.mjs';

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

// A mistake that leaves the whole file untrustworthy (unreadable, an unknown
// top-level key, a section of the wrong shape) is not run on defaults: the
// server still starts, so the operator can read why, but every consultation is
// refused (jobs.mjs) -- falling back would quietly re-enable a CLI the
// operator turned off. A mistake inside one consultant or one CLI only takes
// that one out of use, with the reason.
const BUILT = buildConsultants(CONFIG);
if (!configError && BUILT.global.length) configError = `${CONFIG_PATH}: ${BUILT.global.join('; ')}`;
const FROM = configError ? buildConsultants({}) : BUILT;
const LOCAL = configError ? [] : BUILT.problems.filter((p) => !BUILT.global.includes(p));

/** What is wrong with the config file as a whole, or null. Reported at startup; while set, nothing can be started. */
export function configProblem() {
  return configError;
}

/** The mistakes kept to one consultant or one CLI, each of which is out of use until fixed. */
export function configWarnings() {
  return LOCAL.map((p) => `${CONFIG_PATH}: ${p}`);
}

/** Why the consultant of this name is out of use because of a config mistake, or null. */
export function brokenConsultant(name) {
  const p = !configError && Object.hasOwn(BUILT.broken, name) ? BUILT.broken[name] : null;
  return p ? `the config file has a mistake in it: ${p.join('; ')}` : null;
}

const usable = configError ? {} : CONFIG;
// A CLI whose own section has a mistake is off, whatever else the section says.
const cfgCli = (id) => {
  if (Object.hasOwn(BUILT.brokenClis, id) && !configError) {
    return { enabled: false, note: `turned off: the config file has a mistake in clis.${id}: ${BUILT.brokenClis[id].join('; ')}` };
  }
  return usable.clis && typeof usable.clis === 'object' ? usable.clis[id] ?? {} : {};
};
const cfgServer = usable.server && typeof usable.server === 'object' ? usable.server : {};

/**
 * Is this command runnable here? Absolute/relative paths are checked as given.
 * Exported so the config generator can report what a machine has without
 * going through POLICY, which already reflects any config file it found.
 */
export function isInstalled(command) {
  return findCommand(command) !== null;
}

const num = (name, dflt, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, v));
};

// A number the env or the config file may set: env > file > default, clamped to
// the same range whichever one supplied it. Codex and OpenCode do not pass the
// user's shell environment to an MCP server, so for them the file is the only
// place an operator can reach without editing the client's registration.
const limit = (name, fromCfg, dflt, min, max) => {
  const fromEnv = num(name, null, min, max);
  if (fromEnv !== null) return fromEnv;
  if (typeof fromCfg === 'number' && Number.isFinite(fromCfg)) return Math.min(max, Math.max(min, fromCfg));
  return dflt;
};

const str = (name, dflt) => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? dflt : raw;
};

// The CLI a lead runs in, by any everyday name. Only `caller` uses this:
// which consultant a name reaches is consultants.mjs's resolveConsultant.
// Object.create(null) so 'constructor' is an unknown name, not a function.
export const CALLER_ALIASES = Object.freeze(Object.assign(Object.create(null), {
  codex: 'codex', gpt: 'codex', chatgpt: 'codex', openai: 'codex',
  'claude-code': 'claude-code', claude: 'claude-code', anthropic: 'claude-code',
  antigravity: 'antigravity', agy: 'antigravity', gemini: 'antigravity', google: 'antigravity',
  opencode: 'opencode', glm: 'opencode',
}));

export const CALLER_INPUTS = Object.freeze(Object.keys(CALLER_ALIASES));

/** The CLI id for any accepted spelling of a caller, or null. */
export function resolveCaller(raw) {
  const key = normalizeName(raw);
  return typeof key === 'string' && Object.hasOwn(CALLER_ALIASES, key) ? CALLER_ALIASES[key] : null;
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

/**
 * A leading ~ is a shell courtesy, not a path: nothing expands it here, so
 * "~/.local/bin/claudex" would simply not exist and the consultant would drop
 * out of the available list without saying why. Expand it where a path is read.
 */
function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  return /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
}

// env > config file > built-in default, for a CLI's bin.
const binFor = (id, envName, dflt) => {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return expandHome(fromEnv);
  const fromCfg = cfgCli(id).bin;
  return expandHome(typeof fromCfg === 'string' && fromCfg !== '' ? fromCfg : dflt);
};

// Why a consultant is off, in the operator's words: "quota exhausted until
// 15:00" is more use to a lead than a bare refusal, and it is the reason a CLI
// that IS installed gets excluded.
const disabledNote = (id) => {
  const n = cfgCli(id).note;
  return typeof n === 'string' && n.trim() !== '' ? n.trim() : null;
};

const isEnabled = (id, cli) => {
  const flag = cfgCli(id).enabled;
  if (typeof flag === 'boolean') return flag;
  return isInstalled(cli);
};

const CODEX_BIN = binFor('codex', 'SEVERALLY_CODEX_BIN', 'codex');
const CLAUDE_BIN = binFor('claude-code', 'SEVERALLY_CLAUDE_BIN', 'claude');
const AGY_BIN = binFor('antigravity', 'SEVERALLY_AGY_BIN', 'agy');
const OPENCODE_BIN = binFor('opencode', 'SEVERALLY_OPENCODE_BIN', 'opencode');

// Operator-only extras for the child process (config: args, env). Config-only,
// never from a request, and validated at launch (jobs.mjs) where the isolation
// flags and variables they must not undo are known.
const extras = (id) => ({ extraArgs: cfgCli(id).args ?? [], extraEnv: cfgCli(id).env ?? {} });

export const POLICY = Object.freeze({
  home: str('SEVERALLY_HOME', path.join(os.homedir(), '.severally')),

  // Per CLI: how to launch it and whether it can run here. What runs on it is
  // a consultant's business.
  clis: Object.freeze({
    codex: Object.freeze({
      cli: CODEX_BIN, available: isEnabled('codex', CODEX_BIN), note: disabledNote('codex'), label: 'Codex CLI', ...extras('codex'),
    }),
    'claude-code': Object.freeze({
      cli: CLAUDE_BIN, available: isEnabled('claude-code', CLAUDE_BIN), note: disabledNote('claude-code'), label: 'Claude Code CLI', ...extras('claude-code'),
    }),
    // Where the real Antigravity credentials live is credentialsHome() below,
    // not a field here: the sandbox reads it per job (see timeoutMs()).
    antigravity: Object.freeze({
      cli: AGY_BIN, available: isEnabled('antigravity', AGY_BIN), note: disabledNote('antigravity'), label: 'Antigravity CLI', ...extras('antigravity'),
    }),
    opencode: Object.freeze({
      cli: OPENCODE_BIN, available: isEnabled('opencode', OPENCODE_BIN), note: disabledNote('opencode'), label: 'OpenCode CLI', ...extras('opencode'),
      // opencode.json `provider` definitions copied into the sandbox config:
      // the only way to reach a provider the sandbox's empty HOME would not
      // know, such as a local OpenAI-compatible server.
      provider: cfgCli('opencode').provider ?? {},
    }),
  }),
  // Who can be asked, in config order, and how a name that fits several is
  // settled. See consultants.mjs.
  consultants: FROM.consultants,
  ranking: FROM.ranking,

  // Grace period between SIGTERM and SIGKILL of the child process group.
  killGraceMs: limit('SEVERALLY_KILL_GRACE_MS', cfgServer.kill_grace_ms, 5_000, 500, 60_000),
  // Automatic re-runs of a consultation that failed with a transient error
  // (rate_limited, cli_error), inside the job's original time budget. The
  // wait before the n-th re-run is retryBackoffMs * 3^(n-1).
  maxAutoRetries: limit('SEVERALLY_MAX_AUTO_RETRIES', cfgServer.max_auto_retries, 2, 0, 3),
  retryBackoffMs: limit('SEVERALLY_RETRY_BACKOFF_MS', cfgServer.retry_backoff_ms, 5_000, 0, 60_000),
  // Default: 1 initial round + 4 follow-ups; operators may allow up to 20 total.
  maxRounds: limit('SEVERALLY_MAX_ROUNDS', cfgServer.max_rounds, 5, 1, 20),
  // Default 9 so several independent consultations can run at once; a
  // "consult everyone" fan-out (the three peers plus a fresh session of the
  // caller's own CLI) fits well inside it. The ceiling equals the default:
  // going beyond that is an operator decision with quota to match.
  maxConcurrent: limit('SEVERALLY_MAX_CONCURRENT', cfgServer.max_concurrent, 9, 1, 9),
  maxJobsRetained: limit('SEVERALLY_MAX_JOBS_RETAINED', cfgServer.max_jobs_retained, 200, 20, 2000),
  // Upper bound for consult_get(wait_ms). 45 s stays under the 60 s some MCP
  // clients allow a tool call, so a long wait does not blow up as a client-side
  // timeout while the consultation is still healthy; a client registration
  // that is known to wait longer raises it (scripts/install.mjs).
  // "off" takes the web away from every consultation, whatever the request
  // asks; "on" leaves it to each request's own network.
  network: (process.env.SEVERALLY_NETWORK || cfgServer.network) === 'off' ? 'off' : 'on',
  maxWaitMs: limit('SEVERALLY_MAX_WAIT_MS', cfgServer.max_wait_ms, 45_000, 0, 600_000),

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
    // expose_paths: how many paths a lead may name, and what the copy of
    // them may add up to. Fixed like every other input cap -- a consultant
    // that can be pointed at more of the disk by configuration is a
    // different consultant, not a tuned one.
    exposePathsMax: 20,
    exposeFilesMax: 500,
    exposeBytesMax: 5_000_000,
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

/**
 * Wall-clock budget for one consultation of this consultant. Read at job
 * start (not frozen into the module) so an operator restart is not needed to
 * retune the shared value, and per consultant because they do not take the
 * same time: a long Gemini answer should not force the same patience on every
 * other consultant. The two hour ceiling stays -- past that the answer is a
 * different request, not a slower one.
 */
export function timeoutMs(consultant) {
  return consultant?.timeoutMs ?? limit('SEVERALLY_TIMEOUT_MS', cfgServer.timeout_ms, 1_800_000, 1_000, 7_200_000);
}

/**
 * How long agy may stay alive once it has said it is done: after its `result`
 * event, and after its `finish` step when no result follows. Normally both
 * arrive and the process exits within half a second. Read at call time like
 * timeoutMs(); the variables exist for the tests.
 */
export function agyExitGraceMs() {
  return {
    afterResult: limit('SEVERALLY_AGY_AFTER_RESULT_MS', undefined, 10_000, 100, 600_000),
    afterFinish: limit('SEVERALLY_AGY_AFTER_FINISH_MS', undefined, 60_000, 100, 600_000),
  };
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

/**
 * The same for opencode: the HOME-like root that holds .local/share/opencode
 * (whose auth.json is where `opencode auth login` writes provider keys). The
 * per-job sandbox links that file into its synthesised HOME.
 */
export function opencodeCredentialsHome() {
  return str('SEVERALLY_OPENCODE_CRED_HOME', os.homedir());
}

// Paths a consultant may not read even though it can read the rest of the
// disk: credentials, other tools' sessions, and severally's own history, which
// holds earlier briefs about other work. A consultant that can browse could
// otherwise read one of these and carry it out in a URL. Enforced for Claude
// Code and OpenCode (permission deny rules) and Antigravity (the tool hook),
// and never copied by expose_paths; Codex's read-only sandbox cannot express
// path rules, which the boundary record says.
export const PROTECTED_HOME_PATHS = Object.freeze([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh', '.config/hub',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.cargo/credentials', '.cargo/credentials.toml',
  '.terraform.d', '.vault-token', 'Library/Keychains',
  '.codex', '.claude', '.claude.json', '.gemini', '.config/opencode', '.local/share/opencode',
]);
// Under POLICY.home, wherever the operator moved it.
const PROTECTED_SEVERALLY_PATHS = Object.freeze(['history', 'backups', 'config.json', 'config.jsonc', 'homes',
  // Where homes lived before 1.7: one left by an interrupted run can still hold an auth.json copy.
  'jobs/*/home']);
// File names protected wherever they are.
export const PROTECTED_FILE_NAMES = Object.freeze([
  '.env', '.env.*', '.npmrc', '.netrc', '.pypirc', '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);

/** Absolute protected roots, with forward slashes; `*` stands for one path segment. */
export function protectedRoots() {
  const fwd = (p) => p.replaceAll('\\', '/');
  return [
    ...PROTECTED_HOME_PATHS.map((rel) => fwd(path.join(os.homedir(), rel))),
    ...PROTECTED_SEVERALLY_PATHS.map((rel) => fwd(path.join(POLICY.home, rel))),
  ];
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
// Case-insensitive where the default file system is: Windows and macOS.
export const PATHS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
/** Regex sources: one per protected root, matching it and anything under it. */
export function protectedRootPatterns(extraRoots = []) {
  return [...protectedRoots(), ...extraRoots.map((r) => r.replaceAll('\\', '/'))]
    .map((r) => `^${escapeRe(r.replace(/\/+$/, '')).replaceAll('*', '[^/]+')}(/|$)`);
}
/** Regex sources for PROTECTED_FILE_NAMES, matched against a base name. */
export function protectedNamePatterns() {
  return PROTECTED_FILE_NAMES.map((n) => `^${escapeRe(n).replaceAll('*', '.*')}$`);
}

/** Whether an absolute path, or the file it links to, is protected. */
export function isProtectedPath(abs) {
  const flags = PATHS_CASE_INSENSITIVE ? 'i' : '';
  const roots = protectedRootPatterns().map((p) => new RegExp(p, flags));
  const names = protectedNamePatterns().map((p) => new RegExp(p, flags));
  let real = abs;
  try { real = fs.realpathSync.native(abs); } catch { /* missing: check the name as given */ }
  return [abs, real].some((p) => {
    const fwd = p.replaceAll('\\', '/');
    return roots.some((re) => re.test(fwd)) || names.some((re) => re.test(path.basename(fwd)));
  });
}

export const artifactKinds = ['code', 'log', 'doc', 'data', 'diff', 'spec', 'test-output', 'config'];

/** The consultant with this exact name, or undefined. */
export function consultantByName(name) {
  return POLICY.consultants.find((c) => c.name === name);
}

/** Can this consultant run here: turned on itself, and its CLI usable. */
export function consultantAvailable(c) {
  return c.enabled && POLICY.clis[c.cli].available;
}

/**
 * Why this consultant cannot be reached, or null when it can. The operator's
 * own note wins: "installed but rate-limited" is a case only they can state.
 */
export function unavailableReason(c) {
  if (!c || consultantAvailable(c)) return null;
  if (!c.enabled) return c.note ?? 'turned off in the operator configuration';
  const cli = POLICY.clis[c.cli];
  if (cli.note) return cli.note;
  if (!isInstalled(cli.cli)) return `${cli.cli} is not installed here`;
  return 'turned off in the operator configuration';
}

/** The consultants this machine can actually reach, in config order. */
export function availableConsultants() {
  return POLICY.consultants.filter(consultantAvailable);
}

export function limitsSummary() {
  const list = availableConsultants();
  const by = (f) => Object.fromEntries(list.map((c) => [c.name, f(c)]));
  return {
    available_targets: list.map((c) => c.name),
    // A consultant or CLI out of use because of a mistake in its own section.
    ...(LOCAL.length ? { config_mistakes: configWarnings() } : {}),
    clis: by((c) => c.cli),
    models: by((c) => c.model),
    // Per consultant, because they no longer share one budget.
    timeout_ms: by(timeoutMs),
    max_rounds_per_chain: POLICY.maxRounds,
    // "off": the operator has taken the web away from every consultation.
    network: POLICY.network,
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
      'directory and is not told where your repository is -- unless context.expose_paths names files or ' +
      'directories, which are copied read-only into that working directory and are then the only part of ' +
      'your repository it has; file edits, network access, MCP tools and further consultations denied; the ' +
      'Codex consultant additionally has a read-only shell',
  };
}
