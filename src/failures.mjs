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

// Order matters: a message naming a used-up quota is usage_limit even when it
// also says 429, and only what is left is treated as transient. A message
// that fits neither -- Gemini's bare RESOURCE_EXHAUSTED is one -- falls
// through to cli_error.
/** @type {Array<[RegExp, string]>} */
const RULES = [
  [
    /\b(usage limit|quota (exceeded|reached|exhausted)|out of credits|reached your .* limit|insufficient_quota|credit balance)\b/i,
    'usage_limit',
  ],
  [
    /\b(rate.?limit(ed)?|too many requests|429|overloaded|529|502|503|service unavailable|temporarily unavailable)\b/i,
    'rate_limited',
  ],
  [/\b(not logged in|please log in|login required|unauthorized|authentication|invalid api key|expired token|401|403)\b/i, 'auth'],
  [
    /\b(unrecognized_model|model unavailable|model .* (not found|does not exist|unavailable|not recognized)|no access to .*model|it may not exist|variant unavailable|404)\b/i,
    'model_unavailable',
  ],
];

export function classifyMessage(text, fallback = 'cli_error') {
  if (!text) return fallback;
  for (const [re, kind] of RULES) if (re.test(text)) return kind;
  return fallback;
}

/** Whether the lead may reasonably try again (with a longer budget, or later). */
export function isRetriable(kind) {
  return kind === 'timeout' || kind === 'cli_error' || kind === 'rate_limited' || kind === 'interrupted';
}

/**
 * The failures the server re-runs by itself, inside the job's own budget.
 * Not timeout: it already spent the budget. Not usage_limit, auth or
 * model_unavailable: running the same thing again gives the same answer.
 */
export const AUTO_RETRY_KINDS = Object.freeze(['rate_limited', 'cli_error']);
