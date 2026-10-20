// Credential scrubbing. Applied on the way out (brief sent to the consultant),
// on the way in (consultant output), and to everything persisted to disk.

const CODE_WORDS = new Set([
  'true',
  'false',
  'null',
  'none',
  'undefined',
  'string',
  'str',
  'number',
  'boolean',
  'bool',
  'int',
  'bytes',
]);

// A password-type value that is code, not a secret: a flag or a type, a
// variable reference (${X}, $X, process.env.X, os.environ[...]), and -- unless
// it is a long value under a full PASSWORD/PASSWD name, which stays masked
// whatever it looks like -- a dotted name, a call or a borrow (&str).
/**
 * @param {string} name
 * @param {string} value
 */
function looksLikeCode(name, value) {
  if (
    CODE_WORDS.has(value.toLowerCase()) ||
    value.startsWith('${') ||
    /^\$[A-Z_][A-Z0-9_]*$/.test(value) ||
    /^(?:process\.env\.|os\.environ\b)/.test(value)
  )
    return true;
  if (value.length >= 8 && /^PASSW(?:OR)?D$/i.test(/** @type {string} */ (name.split('_').at(-1)))) return false;
  return /^[A-Za-z_][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /^[A-Za-z_][\w$.]*\(/.test(value) || value.startsWith('&');
}

// A replacement is a string or a function of the match.
/** @type {Array<[RegExp, string | ((...groups: string[]) => string)]>} */
const PATTERNS = [
  // Provider API keys
  [/\bsk-ant-[A-Za-z0-9_-]{12,}/g, '[REDACTED:anthropic-key]'],
  [/\bsk-proj-[A-Za-z0-9_-]{12,}/g, '[REDACTED:openai-key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g, '[REDACTED:slack-webhook]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key-id]'],
  [/\bASIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key-id]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED:google-api-key]'],
  // Stripe secret and restricted keys (pk_ is public, left alone), npm, GitLab, Hugging Face
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED:stripe-key]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED:npm-token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED:gitlab-token]'],
  [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED:huggingface-token]'],
  // JWT / OAuth access tokens (3 base64url segments)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [REDACTED:token]'],
  // PEM private keys
  [/-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  // The password in a URL's userinfo, also with an empty user (redis://:pass@host)
  [/(:\/\/[^\s:/@]*:)[^\s@/]+(@)/g, '$1[REDACTED]$2'],
  // KEY=value / "token": "value" style assignments
  [
    /\b((?:[A-Za-z0-9_]*_)?(?:API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SECRET_KEY|CLIENT_SECRET|AUTH_TOKEN|CREDENTIALS|ACCOUNTKEY|SHAREDACCESSKEY|SECRET|TOKEN))(["']?\s*[:=]\s*["']?)([^\s"',;)]{8,})/gi,
    (_m, k, sep, _v) => `${k}${sep}[REDACTED]`,
  ],
  // Password-type names, with values from 4 characters; PASS and PWD too (PWD
  // only after `_` or a letter: bare PWD is the working directory). What reads
  // as code rather than a password is left alone (looksLikeCode).
  [
    /\b((?:[A-Za-z0-9_]*_)?(?:PASSWORD|PASSWD|PASS|(?<=[A-Za-z_])PWD))(["']?\s*[:=]\s*["']?)([^\s"',;)]{4,})/gi,
    (m, k, sep, v) => (looksLikeCode(k, v) ? m : `${k}${sep}[REDACTED]`),
  ],
  // Any environment variable named *_KEY. Upper case only: in code, primary_key,
  // sort_key and idempotency_key name things, not secrets.
  [/\b([A-Z0-9_]+_KEY)(\s*=\s*["']?)([^\s"',;)]{8,})/g, (_m, k, sep, _v) => `${k}${sep}[REDACTED]`],
];

/**
 * Any JSON-like value in, the same shape out with its strings scrubbed.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let out = /** @type {string} */ (value);
    // The same call either way: replace() has one overload for a string and one for a function.
    for (const [re, rep] of PATTERNS) out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
    return /** @type {T} */ (/** @type {unknown} */ (out));
  }
  if (Array.isArray(value)) return /** @type {T} */ (/** @type {unknown} */ (value.map(redact)));
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return /** @type {T} */ (/** @type {unknown} */ (out));
  }
  return value;
}

/** @param {unknown} text */
export function containsSecret(text) {
  if (typeof text !== 'string') return false;
  return redact(text) !== text;
}
