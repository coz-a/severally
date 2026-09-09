// Distinguishing "the consultant never delivered" from "the consultant
// delivered, but on thin evidence" matters for what the lead does next, so the
// non-delivery cases are classified explicitly.

export const FAILURE_KINDS = [
  'timeout',          // wall-clock budget exhausted
  'cancelled',        // consult_cancel, or server shutdown
  'auth',             // not logged in / credentials rejected
  'usage_limit',      // account quota or rate limit
  'model_unavailable',// model name rejected or not accessible
  'invalid_output',   // ran, but produced nothing parseable against the schema
  'cli_error',        // CLI exited non-zero for another reason
  'spawn_error',      // the CLI could not be started at all
];

const RULES = [
  [/\b(usage limit|quota exceeded|rate limit|out of credits|reached your .* limit|insufficient_quota|429)\b/i, 'usage_limit'],
  [/\b(not logged in|please log in|login required|unauthorized|authentication|invalid api key|expired token|401|403)\b/i, 'auth'],
  [/\b(unrecognized_model|model .* (not found|does not exist|unavailable)|no access to .*model|it may not exist|404)\b/i, 'model_unavailable'],
];

export function classifyMessage(text, fallback = 'cli_error') {
  if (!text) return fallback;
  for (const [re, kind] of RULES) if (re.test(text)) return kind;
  return fallback;
}

export function isRetriable(kind) {
  return kind === 'timeout' || kind === 'cli_error';
}
