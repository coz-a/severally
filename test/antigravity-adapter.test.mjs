import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers.mjs';

sandboxEnv();
const adapter = await import('../src/adapters/antigravity.mjs');
const { POLICY, timeoutMs } = await import('../src/policy.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;

test('the invocation pins the model, the schema and print-mode JSON', () => {
  const inv = adapter.buildInvocation({ workdir: '/tmp/work', schemaPath: '/tmp/schema.json' });
  assert.equal(inv.command, POLICY.targets.antigravity.cli);
  // stream-json, so the step events before the final result survive a timeout.
  assert.deepEqual(inv.args.slice(0, 2), ['--output-format', 'stream-json']);
  assert.ok(inv.args.includes('--json-schema'));
  assert.equal(inv.args[inv.args.indexOf('--json-schema') + 1], '/tmp/schema.json');
  assert.ok(inv.args.includes('--disable-slash-commands'));
  // The slug itself is policy, not a fact about the adapter: assert that the
  // configured model reaches --model, not that it happens to be the default.
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], POLICY.targets.antigravity.model);
  // The shipped default is still worth pinning somewhere -- sandboxEnv() clears
  // SEVERALLY_AGY_MODEL, so this reads the default and not the host's knob.
  assert.equal(POLICY.targets.antigravity.model, 'gemini-3.8-flash-high');
  assert.ok(/^--print-timeout$/.test(inv.args[inv.args.indexOf('--print-timeout')]));
  // agy's own timeout is deliberately longer than ours, so our SIGTERM lands
  // first and the failure is classified as a timeout rather than as a missing
  // envelope.
  const printTimeout = inv.args[inv.args.indexOf('--print-timeout') + 1];
  assert.match(printTimeout, /^\d+s$/);
  assert.ok(Number.parseInt(printTimeout, 10) * 1000 > timeoutMs('antigravity'),
    'agy must not be allowed to give up before we do');
  // agy takes the brief on stdin; the brief must never be an argv value.
  assert.equal(inv.args.includes('-p'), false);
  assert.equal(inv.args.includes('--effort'), false, 'the effort is part of the model name');
});

test('every flag that would widen the consultant is refused', () => {
  const flags = [
    '--dangerously-skip-permissions', '--add-dir', '--continue', '-c', '--conversation',
    '--prompt-interactive', '-i', '--new-project',
    // Documented by `agy --help` at 1.1.28: --mode accept-edits widens the
    // permission posture, --agent brings another agent's tools and
    // instructions, --input-format stream-json makes print mode multi-turn.
    '--mode', '--agent', '--input-format',
  ];
  for (const flag of flags) {
    assert.ok(adapter.FORBIDDEN_FLAGS.includes(flag), `${flag} must be forbidden`);
  }
  // The invocation the adapter actually builds must survive the guard.
  const inv = adapter.buildInvocation({ workdir: '/tmp/work', schemaPath: '/tmp/schema.json' });
  for (const flag of flags) {
    assert.equal(inv.args.includes(flag), false, `the adapter must not itself pass ${flag}`);
  }
});

test('structured_output is preferred over the prose response', () => {
  const out = adapter.interpret({
    stdout: line({ status: 'SUCCESS', response: 'prose\n{"summary":"x"}', structured_output: { summary: 'from structured' }, usage: {} }),
    stderr: '',
    code: 0,
  });
  assert.equal(out.ok, true);
  assert.equal(out.text.summary, 'from structured');
});

test('an ERROR envelope is classified, not treated as advice', () => {
  const out = adapter.interpret({
    stdout: line({ status: 'ERROR', response: '', error: 'You have reached your usage limit for this model.', usage: {} }),
    stderr: '',
    code: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'usage_limit');
});

test('a run with no JSON at all is a failure, not an empty answer', () => {
  const out = adapter.interpret({ stdout: 'panic: something went wrong\n', stderr: '', code: 2 });
  assert.equal(out.ok, false);
  assert.ok(out.message.length > 0);
});

test('usage is mapped onto the common record and no cost is invented', () => {
  const rec = adapter.usageRecord({
    num_turns: 2,
    usage: { input_tokens: 10, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 7, total_tokens: 13 },
    denied_actions: [{ action: 'read_url', display_name: 'ReadUrlContent' }],
  });
  assert.equal(rec.input_tokens, 10);
  assert.equal(rec.cached_input_tokens, 7);
  assert.equal(rec.output_tokens, 3);
  assert.equal(rec.total_tokens, 13);
  assert.equal(rec.thinking_tokens, 1);
  assert.equal(rec.turns, 2);
  assert.equal(rec.cost_usd, null, 'agy reports no cost; it must not be guessed');
  assert.deepEqual(rec.denied_actions, ['read_url']);
});

// stream-json means the final answer arrives as the last `result` event.
test('the answer is read out of the stream-json result event', () => {
  const stream = [
    JSON.stringify({ event: 'init' }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, step_type: 'tool', tool_name: 'search_web', state: 'ACTIVE' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: { summary: 'from stream' }, usage: {} } }),
  ].join('\n');
  const out = adapter.interpret({ stdout: stream, stderr: '', code: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.text.summary, 'from stream');
});

test('an ERROR result event is still classified, not treated as advice', () => {
  const stream = JSON.stringify({
    event: 'result',
    result: { status: 'ERROR', error: 'You have reached your usage limit for this model.', usage: {} },
  });
  const out = adapter.interpret({ stdout: stream, stderr: '', code: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'usage_limit');
});

// The point of streaming: a consultation killed at its budget leaves a trail.
test('progress says how far a consultation has got', () => {
  const stream = [
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', tool_name: 'search_web', state: 'ACTIVE' } }),
    '{"event":"step_update","step_upda',  // a line cut off mid-write, as a kill does
  ].join('\n');

  const summary = adapter.progress({ stdout: stream });
  assert.match(summary, /2 step\(s\)/);
  assert.match(summary, /search_web/);
  assert.match(summary, /ACTIVE/);
});

test('progress is null when there is nothing to report', () => {
  assert.equal(adapter.progress({ stdout: '' }), null);
  assert.equal(adapter.progress({ stdout: 'not json at all\n' }), null);
});
