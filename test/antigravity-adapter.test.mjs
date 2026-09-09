import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers.mjs';

sandboxEnv();
const adapter = await import('../src/adapters/antigravity.mjs');
const { POLICY } = await import('../src/policy.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;

test('the invocation pins the model, the schema and print-mode JSON', () => {
  const inv = adapter.buildInvocation({ workdir: '/tmp/work', schemaPath: '/tmp/schema.json' });
  assert.equal(inv.command, POLICY.targets.antigravity.cli);
  assert.deepEqual(inv.args.slice(0, 2), ['--output-format', 'json']);
  assert.ok(inv.args.includes('--json-schema'));
  assert.equal(inv.args[inv.args.indexOf('--json-schema') + 1], '/tmp/schema.json');
  assert.ok(inv.args.includes('--disable-slash-commands'));
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.ok(/^--print-timeout$/.test(inv.args[inv.args.indexOf('--print-timeout')]));
  assert.match(inv.args[inv.args.indexOf('--print-timeout') + 1], /^\d+s$/);
  // agy takes the brief on stdin; the brief must never be an argv value.
  assert.equal(inv.args.includes('-p'), false);
  assert.equal(inv.args.includes('--effort'), false, 'the effort is part of the model name');
});

test('every flag that would widen the consultant is refused', () => {
  for (const flag of ['--dangerously-skip-permissions', '--add-dir', '--continue', '-c', '--conversation', '--prompt-interactive', '-i', '--new-project']) {
    assert.ok(adapter.FORBIDDEN_FLAGS.includes(flag), `${flag} must be forbidden`);
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
