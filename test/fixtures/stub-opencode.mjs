#!/usr/bin/env node
// Stand-in for `opencode run --format json` used by the test suite. The event
// shapes match opencode 1.18.31: {type, timestamp, sessionID, ...} lines on
// stdout, the answer as the last completed `text` part, usage and cost on the
// `step-finish` parts.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (process.env.STUB_ARGV_OUT) fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(args));
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify(process.env));

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => run());
if (process.stdin.isTTY) run();

const emit = (type, data) =>
  process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID: 'ses_stub', ...data })}\n`);

function answer(overrides = {}) {
  return {
    summary: 'Stub opencode summary of the proposal.',
    confidence: 'medium',
    evidence_basis: 'sufficient',
    stance: 'proceed',
    findings: [{ point: 'Unbounded retry', grounds: 'The excerpt has no cap.', impact: 'Load amplification', severity: 'high', confidence: 'medium' }],
    alternatives: [{ option: 'Circuit breaker', tradeoffs: 'More moving parts', when_preferred: 'When the dependency flaps' }],
    unknowns: [{ item: 'Peak QPS', why_it_matters: 'Sets the cap', how_to_obtain: 'Check the dashboard' }],
    decision_changers: [{ condition: 'QPS below 5', changes_to: 'No cap needed' }],
    next_checks: [{ check: 'Load test', method: 'Replay peak traffic', expected_signal: 'p99 under 300ms' }],
    remaining_disagreements: [],
    references: [{ title: 'brief', url: '(brief)', relevance: 'supplied excerpt' }],
    ...overrides,
  };
}

const stepFinish = () => emit('step_finish', {
  // Shape verified live against opencode 1.18.31 (glm-5.3): tokens carries
  // total/input/output/reasoning plus cache.read/cache.write, and cost is a
  // number (0 on a coding plan).
  part: { type: 'step-finish', tokens: { total: 21, input: 10, output: 3, reasoning: 1, cache: { read: 7, write: 2 } }, cost: 0.02 },
});

function run() {
  if (process.env.STUB_BRIEF_OUT) fs.writeFileSync(process.env.STUB_BRIEF_OUT, stdin);
  // STUB_BRIEF_OUT is a single shared path: in a fan-out several children would
  // overwrite each other's brief, so also drop one file per target.
  if (process.env.STUB_BRIEF_DIR) {
    fs.writeFileSync(path.join(process.env.STUB_BRIEF_DIR, `${process.env.SEVERALLY_TARGET ?? 'unknown'}.txt`), stdin);
  }
  const behavior = process.env.STUB_BEHAVIOR ?? 'ok';

  if (behavior === 'usage_limit') {
    emit('error', { error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit for this model. Try again later.' } } });
    process.exit(1);
  }
  if (behavior === 'auth') {
    emit('error', { error: { name: 'ProviderAuthError', data: { message: 'not logged in: invalid api key (401)' } } });
    process.exit(1);
  }
  if (behavior === 'model_unavailable') {
    emit('error', { error: { name: 'UnknownModelException', data: { message: 'model glm-99 does not exist or you do not have access to it' } } });
    process.exit(1);
  }
  if (behavior === 'invalid') {
    emit('text', { part: { type: 'text', text: 'I cannot comply, here is some prose instead.', time: { start: 1, end: 2 } } });
    stepFinish();
    process.exit(0);
  }
  if (behavior === 'retry_then_answer') {
    // A session.error the CLI recovered from: the error is recorded with the
    // answer, but the answer stands.
    emit('error', { error: { name: 'ProviderAuthError', data: { message: 'rate limited, retrying' } } });
    emit('text', { part: { type: 'text', text: JSON.stringify(answer()), time: { start: 1, end: 2 } } });
    stepFinish();
    process.exit(0);
  }
  if (behavior === 'hang') {
    // Same idea as the codex stub: leave a trail before wedging.
    emit('step_start', { part: { type: 'step-start' } });
    emit('tool_use', { part: { type: 'tool', tool: 'grep', state: { status: 'running' } } });
    const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
    if (process.env.STUB_GRANDCHILD_PID_OUT) fs.writeFileSync(process.env.STUB_GRANDCHILD_PID_OUT, String(gc.pid));
    setInterval(() => {}, 1e9);
    return;
  }
  if (behavior === 'leak_secret') {
    const leaked = answer({ summary: 'Authenticate with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF and retry.' });
    emit('text', { part: { type: 'text', text: JSON.stringify(leaked), time: { start: 1, end: 2 } } });
    stepFinish();
    process.exit(0);
  }

  emit('step_start', { part: { type: 'step-start' } });
  emit('tool_use', { part: { type: 'tool', tool: 'grep', state: { status: 'completed' } } });
  // Interim prose between tool calls must lose to the final part.
  emit('text', { part: { type: 'text', text: 'Interim prose.', time: { start: 1, end: 2 } } });
  emit('text', { part: { type: 'text', text: JSON.stringify(answer()), time: { start: 3, end: 4 } } });
  stepFinish();
  process.exit(0);
}
