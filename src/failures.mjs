// Distinguishing "the consultant never delivered" from "the consultant
// delivered, but on thin evidence" matters for what the lead does next, so the
// non-delivery cases are classified explicitly.

export const FAILURE_KINDS = [
  'timeout', // wall-clock budget exhausted
  'cancelled', // consult_cancel, or server shutdown
  'auth', // not logged in / credentials rejected
  'usage_limit', // account quota or plan limit used up: waiting minutes will not help
  'rate_limited', // a transient refusal (429, overloaded, 5xx): worth one more try
  'model_unavailable', // model name rejected or not accessible
  'invalid_output', // ran, but produced nothing parseable against the schema
  'cli_error', // CLI exited non-zero for another reason
  'spawn_error', // the CLI could not be started at all
  'interrupted', // the severally process running it exited before it finished
];

// Order matters: a used-up quota stays usage_limit even when the message also
// says 429 or names an auth problem; auth errors then beat transient limits.
// A message that fits neither -- Gemini's bare RESOURCE_EXHAUSTED is one --
// falls through to cli_error. Each rule also takes the HTTP statuses listed
// with it.
/** @type {Array<[RegExp, string, string[]]>} */
const RULES = [
  [
    /\b(usage limit|quota (exceeded|reached|exhausted)|out of credits|reached your .* limit|insufficient_quota|credit balance)\b/i,
    'usage_limit',
    [],
  ],
  [
    /\b(not logged in|please log in|login required|unauthorized|authentication|invalid api key|expired token)\b/i,
    'auth',
    ['401', '403'],
  ],
  [
    /\b(rate.?limit(ed)?|too many requests|overloaded|service unavailable|temporarily unavailable)\b/i,
    'rate_limited',
    ['429', '502', '503', '529'],
  ],
  [
    /\b(unrecognized_model|model unavailable|model .* (not found|does not exist|unavailable|not recognized)|no access to .*model|it may not exist|variant unavailable)\b/i,
    'model_unavailable',
    ['404'],
  ],
];

// A number is a status only where a status is written: leading the message,
// in brackets, or straight after status / code / HTTP / error ("API Error:
// 429", "HTTP/1.1 503", "\"code\": 429"). "read 403 tokens" and "Error at
// line 502" are not.
const STATUS = /(?:^\s*|[([]|\b(?:status(?:[ _]code)?|code|http(?:\/[\d.]+)?|error)"?\s*[:=]?\s*[([]?)(\d{3})\b/gi;

/**
 * @param {string | null | undefined} text
 * @param {string} [fallback]
 */
export function classifyMessage(text, fallback = 'cli_error') {
  if (!text) return fallback;
  const statuses = [...text.matchAll(STATUS)].map((m) => m[1]);
  for (const [re, kind, codes] of RULES) if (re.test(text) || codes.some((c) => statuses.includes(c))) return kind;
  return fallback;
}

/**
 * Whether the lead may reasonably try again (with a longer budget, or later).
 * @param {string} kind
 */
export function isRetriable(kind) {
  return kind === 'timeout' || kind === 'cli_error' || kind === 'rate_limited' || kind === 'interrupted';
}

/**
 * The failures the server re-runs by itself, inside the job's own budget.
 * Not timeout: it already spent the budget. Not usage_limit, auth or
 * model_unavailable: running the same thing again gives the same answer.
 */
export const AUTO_RETRY_KINDS = Object.freeze(['rate_limited', 'cli_error']);
