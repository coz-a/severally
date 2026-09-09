import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv, reviewRequest, exploreRequest, debateRequest } from './helpers.mjs';

sandboxEnv();
const { parseRequest, RequestError } = await import('../src/schema.mjs');

const rejects = (raw, code, opts) => {
  try {
    parseRequest(raw, opts);
  } catch (err) {
    assert.ok(err instanceof RequestError, `expected RequestError, got ${err}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected rejection with code ${code}`);
};

test('accepts a well-formed review request', () => {
  const req = parseRequest(reviewRequest());
  assert.equal(req.mode, 'review');
  assert.equal(req.followup_to, null);
  assert.equal(req.context.counterpoints.length, 0);
});

test('explore must withhold the proposal on the first round', () => {
  rejects(exploreRequest({ context: { facts: ['f'], proposal: 'my plan' } }), 'explore_proposal_not_allowed');
});

test('explore may carry a proposal once it is a follow-up', () => {
  const req = parseRequest(exploreRequest({ context: { facts: ['f'], proposal: 'my plan' } }), { isFollowup: true });
  assert.equal(req.context.proposal, 'my plan');
});

test('review and debate require a proposal', () => {
  rejects(reviewRequest({ context: { facts: ['f'] } }), 'proposal_required');
  rejects(debateRequest({ context: { facts: ['f'], counterpoints: ['c'] } }), 'proposal_required');
});

test('debate requires the other side\'s claims', () => {
  rejects(debateRequest({ context: { facts: ['f'], proposal: 'p' } }), 'counterpoints_required');
});

test('some context is always required', () => {
  rejects(reviewRequest({ context: { proposal: 'p' } }), 'context_required');
});

test('unknown fields are rejected rather than silently ignored', () => {
  rejects(reviewRequest({ model: 'gpt-4o' }), 'invalid_request');
  rejects(reviewRequest({ sandbox: 'danger-full-access' }), 'invalid_request');
  rejects(reviewRequest({ max_rounds: 99 }), 'invalid_request');
});

test('unknown target and mode are rejected', () => {
  rejects(reviewRequest({ target: 'grok' }), 'invalid_request');
  rejects(reviewRequest({ mode: 'chat' }), 'invalid_request');
});

test('oversized payloads are rejected', () => {
  const big = 'x'.repeat(19_000);
  const artifacts = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, kind: 'code', excerpt: big }));
  rejects(reviewRequest({ context: { facts: ['f'], proposal: 'p', artifacts } }), 'payload_too_large');
});

test('per-field caps are enforced', () => {
  rejects(reviewRequest({ question: 'q'.repeat(4001) }), 'invalid_request');
  rejects(reviewRequest({ context: { facts: ['f'], proposal: 'p', artifacts: [{ name: 'n', kind: 'code', excerpt: 'x'.repeat(20_001) }] } }), 'invalid_request');
});

test('target accepts vendor aliases and normalises them to canonical ids', () => {
  assert.equal(parseRequest(reviewRequest({ target: 'gpt' })).target, 'codex');
  assert.equal(parseRequest(reviewRequest({ target: 'ChatGPT' })).target, 'codex');
  assert.equal(parseRequest(reviewRequest({ target: 'Claude Code' })).target, 'claude-code');
  assert.equal(parseRequest(reviewRequest({ target: 'claude' })).target, 'claude-code');
  assert.equal(parseRequest(reviewRequest({ target: 'Gemini' })).target, 'antigravity');
  assert.equal(parseRequest(reviewRequest({ target: 'agy' })).target, 'antigravity');
  assert.equal(parseRequest(reviewRequest({ target: 'antigravity' })).target, 'antigravity');
});

test('an unknown target is rejected and the accepted names are listed', () => {
  assert.throws(
    () => parseRequest(reviewRequest({ target: 'grok' })),
    (err) => err.code === 'invalid_request' && /gemini/.test(err.message),
  );
});

test('caller is optional and normalised like target', () => {
  assert.equal(parseRequest(reviewRequest({ caller: 'Claude Code' })).caller, 'claude-code');
  assert.equal(parseRequest(reviewRequest()).caller, null);
});

test('detectCaller reads the host CLI from the environment', async () => {
  const { detectCaller } = await import('../src/policy.mjs');
  assert.equal(detectCaller({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detectCaller({ CODEX_HOME: '/home/x/.codex' }), 'codex');
  assert.equal(detectCaller({ AGY_BROWSER_WS_URL: 'ws://localhost:1' }), 'antigravity');
  assert.equal(detectCaller({}), null);
});

// resolveTarget used to index a plain object literal, so an inherited key
// resolved to a function: resolveTarget('constructor') returned
// Object.prototype.constructor and the request went on to be launched as if
// it named a consultant.
test('an inherited Object.prototype key is not a target', async () => {
  const { resolveTarget } = await import('../src/policy.mjs');
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(resolveTarget(key), null, `${key} must not resolve to a target`);
  }
});

// The zod preprocessor and resolveTarget() must apply the same normalisation:
// if they drift, a target the schema accepted resolves to null and reaches
// POLICY.targets[null].model as a TypeError instead of a validation message.
test('the schema and resolveTarget share one normaliser', async () => {
  const { resolveTarget, TARGET_INPUTS, normalizeTargetInput } = await import('../src/policy.mjs');
  for (const input of TARGET_INPUTS) {
    assert.notEqual(resolveTarget(input), null, `${input} must resolve`);
    assert.equal(normalizeTargetInput(`  ${input.replace(/-/g, '_').toUpperCase()} `), input);
  }
});
