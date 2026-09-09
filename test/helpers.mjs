import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));

export function sandboxEnv(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-test-'));

  // Every assertion in this suite is written against the shipped defaults in
  // policy.mjs, and each of those defaults is an operator knob a developer of
  // *this* project is exactly the person to have exported. So clear the whole
  // PEER_CONSULT_ namespace before pinning what the tests need: leaving it
  // alone made the results depend on the host shell (measured:
  // PEER_CONSULT_MAX_CONCURRENT=1 -> 7 failures,
  // PEER_CONSULT_AGY_MODEL=<other slug> -> 1 failure). Anything not pinned
  // below therefore falls back to the default, which is the single place the
  // value is defined; a test that needs a different one passes it in
  // `overrides` rather than exporting it.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PEER_CONSULT_')) delete process.env[key];
  }

  // A synthesised credential source, so the suite never reads -- and never
  // depends on the presence of -- the developer's real ~/.gemini token.
  const credHome = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-test-cred-'));
  fs.mkdirSync(path.join(credHome, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(
    path.join(credHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    'test-token',
  );

  Object.assign(process.env, {
    PEER_CONSULT_HOME: home,
    PEER_CONSULT_CODEX_BIN: path.join(here, 'fixtures', 'stub-codex.mjs'),
    PEER_CONSULT_CLAUDE_BIN: path.join(here, 'fixtures', 'stub-claude.mjs'),
    PEER_CONSULT_AGY_BIN: path.join(here, 'fixtures', 'stub-agy.mjs'),
    PEER_CONSULT_AGY_CRED_HOME: credHome,
    PEER_CONSULT_TIMEOUT_MS: '20000',
    PEER_CONSULT_KILL_GRACE_MS: '500',
    ...overrides,
  });
  // A test's recorded `caller` must come from the request, not from whichever
  // CLI happens to be hosting the test suite -- strip every marker
  // detectCaller() reads so the default is deterministically "no caller
  // detected" unless a test opts in via an explicit `caller` field.
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AGY_') || key.startsWith('ANTIGRAVITY_')) delete process.env[key];
  }
  // A test's credential state must come from the test, not from the host: the
  // credential check in jobs.mjs treats any of these as an alternative to the
  // linked OAuth token, so a developer with one exported would turn the
  // "unauthenticated child is refused" test green by accident. Measured before
  // this: GOOGLE_APPLICATION_CREDENTIALS=<any path> -> 1 failure.
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return home;
}

export const reviewRequest = (over = {}) => ({
  target: 'codex',
  mode: 'review',
  question: 'Does the retry policy hold under a downstream outage?',
  objective: 'Ship a retry policy that will not amplify an outage.',
  success_criteria: ['A concrete failure scenario or a clear all-clear'],
  constraints: ['No new infrastructure', 'Must stay in the existing service'],
  context: {
    facts: ['The client retries 5 times with 100ms fixed backoff.'],
    proposal: 'Keep 5 retries but add jitter, because the outage we saw was short.',
    artifacts: [{ name: 'retry.ts', kind: 'code', language: 'ts', excerpt: 'for (let i=0;i<5;i++) await call();' }],
  },
  ...over,
});

export const exploreRequest = (over = {}) => ({
  target: 'claude-code',
  mode: 'explore',
  question: 'How should we bound the write path latency?',
  objective: 'p99 write latency under 200ms at 3x current traffic.',
  context: { facts: ['Writes currently go straight to Postgres with no batching.'] },
  ...over,
});

export const debateRequest = (over = {}) => ({
  target: 'codex',
  mode: 'debate',
  question: 'Should the cache be write-through or write-behind?',
  objective: 'Pick the cache write strategy for the order service.',
  context: {
    facts: ['Order writes are 200/s peak.'],
    proposal: 'Write-through, because losing an order on a crash is unacceptable.',
    counterpoints: ['Write-behind with a durable log gives the same guarantee at lower latency.'],
  },
  ...over,
});

export const antigravityRequest = (over = {}) => ({
  target: 'gemini',
  mode: 'review',
  question: 'Is the cache invalidation strategy safe under concurrent writes?',
  objective: 'Avoid serving stale orders after a write.',
  context: {
    facts: ['Two app servers write to the same key without coordination.'],
    proposal: 'Invalidate on write and let the next read repopulate, because writes are rare.',
  },
  ...over,
});

export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
