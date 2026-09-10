#!/usr/bin/env node
// Stand-in for `agy` (print mode) used by the test suite. The envelope shape
// matches agy 1.1.28: status / response / structured_output / usage /
// denied_actions, with status ERROR + error for failures.
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

function answer(overrides = {}) {
  return {
    summary: 'Stub antigravity summary of the proposal.',
    confidence: 'medium',
    evidence_basis: 'sufficient',
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

const envelope = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function run() {
  if (process.env.STUB_BRIEF_OUT) fs.writeFileSync(process.env.STUB_BRIEF_OUT, stdin);
  // STUB_BRIEF_OUT is a single shared path: in a fan-out several children would
  // overwrite each other's brief, so also drop one file per target.
  if (process.env.STUB_BRIEF_DIR) {
    fs.writeFileSync(path.join(process.env.STUB_BRIEF_DIR, `${process.env.PEER_CONSULT_TARGET ?? 'unknown'}.txt`), stdin);
  }
  const behavior = process.env.STUB_BEHAVIOR ?? 'ok';
  const usage = { input_tokens: 5722, output_tokens: 240, thinking_tokens: 23, cache_read_tokens: 8130, total_tokens: 5962 };

  if (behavior === 'usage_limit') {
    envelope({ conversation_id: '', status: 'ERROR', response: '', error: 'You have reached your usage limit for this model. Try again later.', usage });
    process.exit(1);
  }
  if (behavior === 'auth') {
    envelope({ conversation_id: '', status: 'ERROR', response: '', error: 'not logged in: run agy to authenticate (401)', usage });
    process.exit(1);
  }
  if (behavior === 'model_unavailable') {
    envelope({ conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection: model gemini-9 is not recognized as a known model', usage });
    process.exit(1);
  }
  if (behavior === 'invalid') {
    envelope({ conversation_id: 'stub', status: 'SUCCESS', response: 'I cannot comply, here is some prose instead.', num_turns: 1, usage });
    process.exit(0);
  }
  if (behavior === 'denied') {
    envelope({
      conversation_id: 'stub', status: 'SUCCESS', num_turns: 2, usage,
      response: JSON.stringify(answer({ evidence_basis: 'thin' })),
      structured_output: answer({ evidence_basis: 'thin' }),
      denied_actions: [{ action: 'read_url', display_name: 'ReadUrlContent' }],
    });
    process.exit(0);
  }
  if (behavior === 'hang') {
    // Same idea as the codex stub: leave a trail before wedging.
    envelope({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE' } });
    envelope({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', tool_name: 'search_web', state: 'ACTIVE' } });
    const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
    if (process.env.STUB_GRANDCHILD_PID_OUT) fs.writeFileSync(process.env.STUB_GRANDCHILD_PID_OUT, String(gc.pid));
    setInterval(() => {}, 1e9);
    return;
  }
  if (behavior === 'leak_secret') {
    const leaked = answer({ summary: 'Authenticate with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF and retry.' });
    envelope({ conversation_id: 'stub', status: 'SUCCESS', num_turns: 1, usage, response: JSON.stringify(leaked), structured_output: leaked });
    process.exit(0);
  }

  envelope({
    conversation_id: 'stub', status: 'SUCCESS', num_turns: 2, duration_seconds: 3.1, usage,
    // agy prints prose and the schema object; structured_output is the reliable field.
    response: `Here is my answer.\n${JSON.stringify(answer())}`,
    structured_output: answer(),
  });
  process.exit(0);
}
