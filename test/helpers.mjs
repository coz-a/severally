import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));

export function sandboxEnv(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-test-'));
  Object.assign(process.env, {
    PEER_CONSULT_HOME: home,
    PEER_CONSULT_CODEX_BIN: path.join(here, 'fixtures', 'stub-codex.mjs'),
    PEER_CONSULT_CLAUDE_BIN: path.join(here, 'fixtures', 'stub-claude.mjs'),
    PEER_CONSULT_AGY_BIN: path.join(here, 'fixtures', 'stub-agy.mjs'),
    PEER_CONSULT_TIMEOUT_MS: '20000',
    PEER_CONSULT_KILL_GRACE_MS: '500',
    ...overrides,
  });
  delete process.env.PEER_CONSULT_ACTIVE;
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
