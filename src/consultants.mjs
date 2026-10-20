// Consultants: who can be asked. A consultant is an operator-named pairing of
// one CLI and one model, so several can share a CLI (GLM and DeepSeek both on
// OpenCode). Everything here is pure -- policy.mjs feeds it the config file,
// schema.mjs and jobs.mjs ask it questions -- so the rules can be tested
// without a server.

/** @typedef {'codex' | 'claude-code' | 'antigravity' | 'opencode'} CliId */

/**
 * One operator-named pairing of a CLI and a model, as built from the config.
 * @typedef {object} Consultant
 * @property {string} name
 * @property {CliId} cli
 * @property {string} model
 * @property {string | null} effort
 * @property {number | null} timeoutMs
 * @property {number | null} maxBudgetUsd
 * @property {string | null} vendor
 * @property {boolean} enabled
 * @property {string | null} note
 */

/**
 * What buildConsultants makes of a config file: the consultants and ranking,
 * and every mistake found (see buildConsultants for the problem groups).
 * @typedef {object} BuiltConsultants
 * @property {readonly Consultant[]} consultants
 * @property {readonly string[]} ranking
 * @property {string[]} problems
 * @property {string[]} global
 * @property {Record<string, string[]>} broken
 * @property {Record<string, string[]>} brokenClis
 */

/** @type {readonly CliId[]} */
export const CLI_IDS = Object.freeze(['codex', 'claude-code', 'antigravity', 'opencode']);

// The model each CLI's consultant runs when the operator defines none.
/** @type {Readonly<Record<CliId, string>>} */
export const DEFAULT_MODELS = Object.freeze({
  codex: 'gpt-6-astra',
  'claude-code': 'claude-opus-5-5',
  antigravity: 'gemini-4-argon-high',
  opencode: 'zai-coding-plan/glm-5.3',
});

// The lineage a CLI's own host model belongs to, for a caller that declared no
// model. OpenCode runs anyone's models, so it has none.
/** @type {Readonly<Record<CliId, string | null>>} */
export const CLI_VENDORS = Object.freeze({ codex: 'openai', 'claude-code': 'anthropic', antigravity: 'google', opencode: null });

// Null-prototype tables, so a request cannot reach Object.prototype through
// them: 'constructor' must be no match, not a function.
/**
 * @param {Record<string, string>} entries
 * @returns {Readonly<Record<string, string>>}
 */
const table = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

// Names that mean "the consultants on this CLI". gpt/claude/gemini/glm are
// deliberately absent: they name model families, and a Claude model hosted on
// OpenCode should answer to "claude" too.
export const CLI_ALIASES = table({
  codex: 'codex',
  'claude-code': 'claude-code',
  antigravity: 'antigravity',
  agy: 'antigravity',
  opencode: 'opencode',
});

// Names that mean "that vendor's consultants, on any CLI".
export const VENDOR_WORDS = table({ openai: 'openai', chatgpt: 'openai', anthropic: 'anthropic', google: 'google' });

// The lineage of a model, read off the first word of its stem.
const STEM_VENDORS = table({
  gpt: 'openai',
  claude: 'anthropic',
  gemini: 'google',
  glm: 'zai',
  deepseek: 'deepseek',
  nemotron: 'nvidia',
});

// Built-in "higher first" orders, each used only inside one model family: an
// "ultra" Nemotron is not above a "flash" DeepSeek. `family` says which
// candidates a list may compare; a family not listed here is never guessed at.
/** @param {readonly Consultant[]} cands */
const sameStem = (cands) => new Set(cands.map((c) => modelStem(c.model).join('-'))).size === 1;
/** @typedef {{ words: string[], family: (cands: readonly Consultant[]) => boolean, last?: boolean }} Tier */
/** @type {readonly Tier[]} */
const TIERS = Object.freeze([
  { words: ['opus', 'sonnet', 'haiku'], family: (cands) => cands.every((c) => modelStem(c.model)[0] === 'claude') },
  { words: ['ultra', 'pro', 'flash', 'lite'], family: (cands) => cands.every((c) => modelStem(c.model)[0] === 'gemini') },
  // Effort words: the last word of the name, between otherwise like models.
  { words: ['max', 'xhigh', 'high', 'medium', 'low'], family: sameStem, last: true },
]);

export const RESERVED_NAMES = Object.freeze(['all']);

/**
 * Case, runs of spaces and underscores folded away: "Claude Code" -> "claude-code".
 * @template T
 * @param {T} raw
 * @returns {T | string}
 */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return raw;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * "zai-coding-plan/glm-5.3" -> ["glm", "5", "3"]: the provider prefix is not part of the model.
 * @param {unknown} model
 * @returns {string[]}
 */
export function modelWords(model) {
  const s = String(model ?? '').toLowerCase();
  return s
    .slice(s.lastIndexOf('/') + 1)
    .split(/[-._#:\s]+/)
    .filter(Boolean);
}

/** @param {string} w */
const isDigitWord = (w) => /^v?\d+$/.test(w);

/**
 * The words before the version: "claude-opus-5-5" -> ["claude", "opus"].
 * @param {unknown} model
 */
export function modelStem(model) {
  const words = modelWords(model);
  const at = words.findIndex(isDigitWord);
  return at === -1 ? words : words.slice(0, at);
}

/**
 * The version right after the stem, as numbers: "deepseek-v4.1-flash" -> [4, 1]; null when there is none.
 * @param {unknown} model
 * @returns {number[] | null}
 */
export function modelVersion(model) {
  const words = modelWords(model);
  const at = words.findIndex(isDigitWord);
  if (at === -1) return null;
  const digits = [];
  for (let i = at; i < words.length && isDigitWord(words[i]); i++) digits.push(Number(words[i].replace(/^v/, '')));
  return digits;
}

/**
 * The operator's word wins; otherwise the stem decides, and an unknown stem is null rather than a guess.
 * @param {unknown} model
 * @param {unknown} [explicit]
 * @returns {string | null}
 */
export function vendorOf(model, explicit = null) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim().toLowerCase();
  const first = modelStem(model)[0] ?? '';
  if (/^o\d/.test(first)) return 'openai';
  return STEM_VENDORS[first] ?? null;
}

/**
 * @param {string[]} hay
 * @param {string[]} needle
 */
const containsRun = (hay, needle) => needle.length > 0 && hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));

/**
 * Does the name appear in the model id as whole words? "claude opus" in "claude-opus-5-5": yes; "g" in "gpt-6": no.
 * @param {unknown} model
 * @param {unknown} wanted
 */
export function matchesWords(model, wanted) {
  return containsRun(modelWords(model), modelWords(wanted));
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
const compareVersions = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * @param {readonly Consultant[]} cands
 * @param {readonly string[]} ranking
 */
function byRanking(cands, ranking) {
  /** @param {Consultant} c */
  const index = (c) => {
    const i = ranking.findIndex((r) => normalizeName(r) === normalizeName(c.name) || matchesWords(c.model, r));
    return i === -1 ? Infinity : i;
  };
  const best = Math.min(...cands.map(index));
  return best === Infinity ? cands : cands.filter((c) => index(c) === best);
}

/**
 * @param {readonly Consultant[]} cands
 * @param {Tier} tier
 */
function byTier(cands, tier) {
  if (!tier.family(cands)) return cands;
  /** @param {Consultant} c */
  const rank = (c) => {
    const words = modelWords(c.model);
    return tier.last ? tier.words.indexOf(/** @type {string} */ (words.at(-1))) : tier.words.findIndex((w) => words.includes(w));
  };
  const ranks = cands.map(rank);
  if (ranks.includes(-1) || new Set(ranks).size === 1) return cands;
  const best = Math.min(...ranks);
  return cands.filter((_, i) => ranks[i] === best);
}

/** @param {readonly Consultant[]} cands */
function byVersion(cands) {
  const stem = modelStem(cands[0].model).join('-');
  const versions = cands.map((c) => modelVersion(c.model));
  if (versions.includes(null) || cands.some((c) => modelStem(c.model).join('-') !== stem)) return cands;
  const known = /** @type {number[][]} */ (versions);
  const best = known.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  return cands.filter((_, i) => compareVersions(known[i], best) === 0);
}

/**
 * One of several candidates, by the operator's ranking, then the built-in
 * tiers, then the version within one stem -- or null when none of those
 * separates them. Never a guess: two names nothing orders stay two.
 * @param {readonly Consultant[]} cands
 * @param {readonly string[]} [ranking]
 * @returns {Consultant | null}
 */
export function rankCandidates(cands, ranking = []) {
  let left = byRanking(cands, ranking);
  for (const tier of TIERS) {
    if (left.length === 1) break;
    left = byTier(left, tier);
  }
  if (left.length > 1) left = byVersion(left);
  return left.length === 1 ? left[0] : null;
}

/** @typedef {{ none: true, consultant?: undefined, ambiguous?: undefined } | { none?: undefined, consultant: Consultant, ambiguous?: undefined } | { none?: undefined, consultant?: undefined, ambiguous: readonly Consultant[] }} Resolution */

/**
 * What a requested name means: a consultant's own name, then a CLI name, then
 * a vendor word, then the words of a model id. Several candidates are ranked;
 * ones that cannot be ranked come back as `ambiguous`, never as a pick.
 * @param {unknown} input
 * @param {readonly Consultant[]} consultants
 * @param {readonly string[]} [ranking]
 * @returns {Resolution}
 */
export function resolveConsultant(input, consultants, ranking = []) {
  const key = normalizeName(input);
  if (typeof key !== 'string' || key === '') return { none: true };
  const own = consultants.find((c) => normalizeName(c.name) === key);
  if (own) return { consultant: own };
  let cands;
  if (CLI_ALIASES[key]) cands = consultants.filter((c) => c.cli === CLI_ALIASES[key]);
  else if (VENDOR_WORDS[key]) cands = consultants.filter((c) => c.vendor === VENDOR_WORDS[key]);
  else cands = consultants.filter((c) => matchesWords(c.model, input));
  if (cands.length === 0) return { none: true };
  if (cands.length === 1) return { consultant: cands[0] };
  const winner = rankCandidates(cands, ranking);
  return winner ? { consultant: winner } : { ambiguous: cands };
}

/**
 * Which consultants doctor checks. The boundary belongs to the CLI, so each
 * CLI is checked once, through its first available consultant -- and a CLI
 * name asks for exactly that one, never an ambiguity between its consultants.
 * Any other name resolves like a request. null when nothing answers to it.
 * @param {unknown} arg
 * @param {readonly Consultant[]} available
 * @param {readonly Consultant[]} all
 * @param {readonly string[]} [ranking]
 * @returns {Consultant[] | null}
 */
export function checkTargets(arg, available, all, ranking = []) {
  /** @type {Map<string, Consultant>} */
  const first = new Map();
  for (const c of available) if (!first.has(c.cli)) first.set(c.cli, c);
  if (arg === null || arg === undefined) return [...first.values()];
  const cli = CLI_ALIASES[/** @type {string} */ (normalizeName(arg))];
  if (cli) return first.has(cli) ? [/** @type {Consultant} */ (first.get(cli))] : null;
  const r = resolveConsultant(arg, all, ranking);
  return r.consultant ? [r.consultant] : null;
}

/**
 * Is the lead's declared model the one the consultant ran? "same" only when
 * the words agree exactly; one being a prefix-like part of the other
 * ("claude-opus-5" in "claude-opus-5-5") is "unknown", because saying either
 * "same" or "different" there would be a claim the server cannot back.
 * @param {unknown} callerModel
 * @param {unknown} consultantModel
 * @returns {'same' | 'unknown' | 'different'}
 */
export function sameModel(callerModel, consultantModel) {
  const a = modelWords(callerModel);
  const b = modelWords(consultantModel);
  if (a.length && a.length === b.length && a.every((w, i) => w === b[i])) return 'same';
  if (containsRun(a, b) || containsRun(b, a)) return 'unknown';
  return 'different';
}

const TOP_KEYS = ['server', 'clis', 'consultants', 'ranking'];
const CLI_KEYS = ['enabled', 'note', 'bin', 'args', 'env', 'provider'];
const CONSULTANT_KEYS = ['cli', 'model', 'effort', 'timeout_ms', 'max_budget_usd', 'vendor', 'enabled', 'note'];
/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * The consultants and ranking a config file defines, with every mistake in it
 * as a problem string. A config without `consultants` gets one consultant per
 * CLI, named after it, on that CLI's default model; whether it can run is the
 * CLI's availability, decided by policy.mjs.
 * @param {unknown} config the parsed config file, before validation
 * @returns {BuiltConsultants}
 */
export function buildConsultants(config) {
  // `problems` is every mistake, for the operator to read; `global` the ones
  // that leave the whole file untrustworthy. A mistake inside one consultant
  // or one CLI is kept to it: that consultant cannot be used (`broken`), that
  // CLI is off (`brokenClis`) -- the closed side either way, so nothing the
  // operator turned off comes back on.
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const global = [];
  /** @type {Record<string, string[]>} */
  const broken = {};
  /** @type {Record<string, string[]>} */
  const brokenClis = {};
  /** @param {string} msg */
  const fault = (msg) => {
    problems.push(msg);
    global.push(msg);
  };
  const cfg = isObject(config) ? config : {};
  if (!isObject(config)) fault('the config file must hold a JSON object');
  for (const key of Object.keys(cfg)) {
    if (!TOP_KEYS.includes(key)) fault(`unknown top-level key "${key}" (allowed: ${TOP_KEYS.join(', ')})`);
  }

  // The one server key that is not a number to clamp: a wrong value cannot
  // be read as either setting, and reading it as "on" would open the web.
  /** @type {readonly unknown[]} */
  const networkModes = ['on', 'off'];
  if (isObject(cfg.server) && cfg.server.network !== undefined && !networkModes.includes(cfg.server.network)) {
    fault('server.network must be "on" or "off"');
  }

  let ranking = [];
  if (cfg.ranking !== undefined) {
    if (Array.isArray(cfg.ranking) && cfg.ranking.every((r) => typeof r === 'string' && r.trim() !== ''))
      ranking = cfg.ranking.map((r) => r.trim());
    else fault('ranking must be an array of non-empty strings');
  }

  /** @type {readonly unknown[]} */
  const cliIds = CLI_IDS;
  if (cfg.clis !== undefined) {
    if (!isObject(cfg.clis)) fault('clis must be an object keyed by CLI');
    else {
      for (const [id, def] of Object.entries(cfg.clis)) {
        if (!cliIds.includes(id)) {
          problems.push(`clis.${id}: unknown CLI (known: ${CLI_IDS.join(', ')})`);
          continue;
        }
        const before = problems.length;
        if (!isObject(def)) {
          problems.push(`clis.${id} must be an object`);
          brokenClis[id] = problems.slice(before);
          continue;
        }
        for (const k of Object.keys(def))
          if (!CLI_KEYS.includes(k)) problems.push(`clis.${id}.${k}: unknown key (allowed: ${CLI_KEYS.join(', ')})`);
        // A wrong type must not fall back to a default: enabled: "false"
        // read as "unset" would turn on the CLI the operator meant to stop.
        if (def.enabled !== undefined && typeof def.enabled !== 'boolean')
          problems.push(`clis.${id}.enabled: must be true or false`);
        for (const k of ['bin', 'note'])
          if (def[k] !== undefined && typeof def[k] !== 'string') problems.push(`clis.${id}.${k}: must be a string`);
        if (def.args !== undefined && !(Array.isArray(def.args) && def.args.every((a) => typeof a === 'string')))
          problems.push(`clis.${id}.args: must be an array of strings`);
        if (def.env !== undefined && !(isObject(def.env) && Object.values(def.env).every((v) => typeof v === 'string')))
          problems.push(`clis.${id}.env: must be an object of strings`);
        if (def.provider !== undefined) {
          if (id !== 'opencode') problems.push(`clis.${id}.provider: only OpenCode takes provider definitions`);
          else if (!(isObject(def.provider) && Object.values(def.provider).every(isObject)))
            problems.push(`clis.${id}.provider: must be an object of provider objects, as in opencode.json`);
        }
        if (problems.length > before) brokenClis[id] = problems.slice(before);
      }
    }
  }

  /** @type {Consultant[]} */
  const consultants = [];
  if (cfg.consultants === undefined) {
    for (const cli of CLI_IDS) consultants.push(make(cli, { cli, model: DEFAULT_MODELS[cli] }));
  } else if (!isObject(cfg.consultants)) {
    fault('consultants must be an object keyed by name');
  } else {
    const seen = new Map();
    for (const [name, def] of Object.entries(cfg.consultants)) {
      const at = `consultants.${name}`;
      if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) {
        problems.push(`${at}: a name is lower-case letters, digits, "." and "-", at most 64 characters`);
        continue;
      }
      if (RESERVED_NAMES.includes(name)) {
        problems.push(`${at}: "${name}" is reserved`);
        continue;
      }
      const before = problems.length;
      if (!isObject(def)) {
        problems.push(`${at} must be an object`);
        broken[name] = problems.slice(before);
        continue;
      }
      for (const k of Object.keys(def))
        if (!CONSULTANT_KEYS.includes(k)) problems.push(`${at}.${k}: unknown key (allowed: ${CONSULTANT_KEYS.join(', ')})`);
      if (!cliIds.includes(def.cli)) problems.push(`${at}.cli: must be one of ${CLI_IDS.join(', ')}`);
      if (typeof def.model !== 'string' || def.model.trim() === '') problems.push(`${at}.model: required`);
      for (const k of ['effort', 'vendor', 'note']) {
        if (def[k] !== undefined && typeof def[k] !== 'string') problems.push(`${at}.${k}: must be a string`);
      }
      if (def.enabled !== undefined && typeof def.enabled !== 'boolean') problems.push(`${at}.enabled: must be true or false`);
      for (const k of ['timeout_ms', 'max_budget_usd']) {
        if (def[k] !== undefined && !(typeof def[k] === 'number' && Number.isFinite(def[k])))
          problems.push(`${at}.${k}: must be a number`);
      }
      if (def.max_budget_usd !== undefined && def.cli !== 'claude-code')
        problems.push(`${at}.max_budget_usd: only a claude-code consultant has a budget`);
      // agy takes the effort from the model name and rejects --effort.
      if (def.effort !== undefined && def.cli === 'antigravity')
        problems.push(`${at}.effort: Antigravity takes the effort from the model name (e.g. gemini-3.8-flash-low)`);
      if (problems.length > before) {
        broken[name] = problems.slice(before);
        continue;
      }
      const valid = /** @type {ConsultantDef} */ (def);
      const pair = `${valid.cli}\n${valid.model.trim()}`;
      if (seen.has(pair)) {
        problems.push(`${at}: same cli and model as consultants.${seen.get(pair)}; asking one model twice adds no independence`);
        broken[name] = problems.slice(before);
        continue;
      }
      seen.set(pair, name);
      consultants.push(make(name, valid));
    }
  }
  return { consultants: Object.freeze(consultants), ranking: Object.freeze(ranking), problems, global, broken, brokenClis };
}

/**
 * A consultant's definition in the config file, once it has passed validation.
 * @typedef {object} ConsultantDef
 * @property {CliId} cli
 * @property {string} model
 * @property {unknown} [effort]
 * @property {unknown} [timeout_ms]
 * @property {unknown} [max_budget_usd]
 * @property {unknown} [vendor]
 * @property {unknown} [enabled]
 * @property {unknown} [note]
 */

/**
 * @param {string} name
 * @param {ConsultantDef} def a definition that has passed validation
 * @returns {Consultant}
 */
function make(name, def) {
  const model = def.model.trim();
  return Object.freeze({
    name,
    cli: def.cli,
    model,
    effort: typeof def.effort === 'string' && def.effort.trim() !== '' ? def.effort.trim() : null,
    timeoutMs: typeof def.timeout_ms === 'number' ? clamp(def.timeout_ms, 1_000, 7_200_000) : null,
    maxBudgetUsd: typeof def.max_budget_usd === 'number' ? clamp(def.max_budget_usd, 0.05, 20) : null,
    vendor: vendorOf(model, def.vendor),
    enabled: def.enabled !== false,
    note: typeof def.note === 'string' && def.note.trim() !== '' ? def.note.trim() : null,
  });
}
