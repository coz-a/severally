// Credential scrubbing. Applied on the way out (brief sent to the consultant),
// on the way in (consultant output), and to everything persisted to disk.

const PATTERNS = [
  // Provider API keys
  [/\bsk-ant-[A-Za-z0-9_\-]{12,}/g, '[REDACTED:anthropic-key]'],
  [/\bsk-proj-[A-Za-z0-9_\-]{12,}/g, '[REDACTED:openai-key]'],
  [/\bsk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key-id]'],
  [/\bASIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key-id]'],
  [/\bAIza[0-9A-Za-z_\-]{30,}/g, '[REDACTED:google-api-key]'],
  // JWT / OAuth access tokens (3 base64url segments)
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '[REDACTED:jwt]'],
  [/\bBearer\s+[A-Za-z0-9._\-]{20,}/gi, 'Bearer [REDACTED:token]'],
  // PEM private keys
  [/-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  // KEY=value / "token": "value" style assignments
  [/\b((?:[A-Za-z0-9_]*_)?(?:API_KEY|APIKEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SECRET_KEY|CLIENT_SECRET|AUTH_TOKEN|PASSWORD|PASSWD|SECRET|TOKEN))(["']?\s*[:=]\s*["']?)([^\s"',;)]{8,})/gi,
    (_m, k, sep, _v) => `${k}${sep}[REDACTED]`],
];

export function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

export function containsSecret(text) {
  if (typeof text !== 'string') return false;
  return redact(text) !== text;
}
