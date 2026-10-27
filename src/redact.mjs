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

// Shared by text assignments and structured properties. Match whole property
// names so code identifiers such as primary_key and api_key_count stay intact.
const SECRET_NAME =
  '(?:[A-Za-z0-9_]*_)?(?:API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SECRET_KEY|CLIENT_SECRET|AUTH_TOKEN|CREDENTIALS|ACCOUNTKEY|SHAREDACCESSKEY|SECRET|TOKEN)';
const PASSWORD_NAME = '(?:[A-Za-z0-9_]*_)?(?:PASSWORD|PASSWD|PASS|(?<=[A-Za-z_])PWD)';
const SECRET_PROPERTY = new RegExp(`^(?:${SECRET_NAME}|${PASSWORD_NAME})$`, 'i');
const ENV_KEY_PROPERTY = /^[A-Z0-9_]+_KEY$/;

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
  if (value.length >= 8 && /^PASSW(?:OR)?D$/i.test(name.split('_').at(-1) ?? '')) return false;
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
  [new RegExp(`\\b(${SECRET_NAME})(["']?\\s*[:=]\\s*["']?)([^\\s"',;)]{8,})`, 'gi'), (_m, k, sep, _v) => `${k}${sep}[REDACTED]`],
  // Password-type names, with values from 4 characters; PASS and PWD too (PWD
  // only after `_` or a letter: bare PWD is the working directory). What reads
  // as code rather than a password is left alone (looksLikeCode).
  [
    new RegExp(`\\b(${PASSWORD_NAME})(["']?\\s*[:=]\\s*["']?)([^\\s"',;)]{4,})`, 'gi'),
    (m, k, sep, v) => (looksLikeCode(k, v) ? m : `${k}${sep}[REDACTED]`),
  ],
  // Any environment variable named *_KEY. Upper case only: in code, primary_key,
  // sort_key and idempotency_key name things, not secrets.
  [/\b([A-Z0-9_]+_KEY)(\s*=\s*["']?)([^\s"',;)]{8,})/g, (_m, k, sep, _v) => `${k}${sep}[REDACTED]`],
];

/**
 * Scrub strings in JSON-like data. Sensitive properties are replaced wholesale
 * with a marker regardless of value type or length; all other structure stays.
 * Unlike text, structured properties are data, so code-looking values are also
 * masked. The generic preserves callers' record types, not credential values.
 * @template T
 * @overload
 * @param {T} value
 * @returns {T}
 */
/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value) {
  return redactWithReport(value).value;
}

export const REDACTION_CAVEAT =
  'Redaction may hide values or structure needed for comparison. Identical markers do not establish equality of the original values; use field presence, types, structure or safe local reproduction. Unobserved stages are unknown.';

/**
 * Observe replacements without retaining originals, hashes or a recovery map.
 * @template T
 * @param {T} value
 * @returns {{value: T, redacted: boolean}}
 */
export function redactWithReport(value) {
  let redacted = false;
  /** @param {unknown} input @returns {unknown} */
  function visit(input) {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') {
      /** @type {string} */
      let out = input;
      // The same call either way: replace() has one overload for a string and one for a function.
      for (const [re, rep] of PATTERNS) out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
      if (out !== input) redacted = true;
      return out;
    }
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, v] of Object.entries(input)) {
        const sensitive = SECRET_PROPERTY.test(k) || ENV_KEY_PROPERTY.test(k);
        if (sensitive && v !== '[REDACTED]') redacted = true;
        // Define a data property so a JSON key named __proto__ is preserved and
        // cannot change the output object's prototype during the recursive copy.
        Object.defineProperty(out, k, {
          value: sensitive ? '[REDACTED]' : visit(v),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return input;
  }
  return { value: /** @type {T} */ (visit(value)), redacted };
}

/** @param {unknown} text */
export function containsSecret(text) {
  if (typeof text !== 'string') return false;
  return redact(text) !== text;
}
