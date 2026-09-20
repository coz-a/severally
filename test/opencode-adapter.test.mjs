import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers.mjs';

sandboxEnv();
const adapter = await import('../src/adapters/opencode.mjs');
const { POLICY } = await import('../src/policy.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;
const textEvent = (text) => line({ type: 'text', part: { type: 'text', text, time: { start: 1, end: 2 } } });
const finishEvent = (tokens, cost) => line({ type: 'step_finish', part: { type: 'step-finish', tokens, cost } });

test('the invocation pins print mode, the event stream and the model', () => {
  const inv = adapter.buildInvocation({ workdir: '/tmp/work', schemaPath: '/tmp/schema.json' });
  assert.equal(inv.command, POLICY.targets.opencode.cli);
  assert.deepEqual(inv.args.slice(0, 3), ['run', '--format', 'json']);
  assert.ok(inv.args.includes('--pure'), 'external plugins stay off even if config loading widens');
  assert.equal(inv.args[inv.args.indexOf('-m') + 1], POLICY.targets.opencode.model);
  // The shipped default is still worth pinning somewhere -- sandboxEnv() clears
  // SEVERALLY_OPENCODE_MODEL, so this reads the default and not the host's knob.
  assert.equal(POLICY.targets.opencode.model, 'zai-coding-plan/glm-5.3');
  // opencode takes the brief on stdin; the brief must never be an argv value.
  assert.equal(inv.args.filter((a) => a === '--title').length, 1);
  assert.equal(inv.args.includes('-f'), false);
});

test('every flag that would widen or re-attach the consultant is refused', () => {
  const flags = [
    // Widening: opencode's default posture is allow-all, so these undo the
    // sandbox's deny rules in one word.
    '--auto', '--yolo', '--dangerously-skip-permissions',
    // Attaching: an outside server brings the user's config, MCP servers and
    // session store back.
    '--attach', '--continue', '-c', '--session', '-s', '--fork',
    // External configuration and exfiltration.
    '--share', '--agent', '--command', '--file', '-f',
    // TUI modes break the one-shot event stream.
    '--interactive', '-i', '--mini', '--demo',
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

test('the answer is the LAST completed text part, not the first', () => {
  const out = adapter.interpret({
    stdout: [
      textEvent('Interim prose while running a tool.'),
      textEvent(JSON.stringify({ summary: 'from the final part' })),
      finishEvent({}, null),
    ].join(''),
    stderr: '',
    code: 0,
  });
  assert.equal(out.ok, true);
  // The text arrives as raw model output; parse-result mines the JSON out of
  // it later (extractJson handles fenced and bare objects).
  assert.deepEqual(JSON.parse(out.text), { summary: 'from the final part' });
});

test('a text part without a completion time is ignored', () => {
  const out = adapter.interpret({
    stdout: line({ type: 'text', part: { type: 'text', text: 'still streaming' } })
      + textEvent(JSON.stringify({ summary: 'done' })),
    stderr: '',
    code: 0,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(out.text), { summary: 'done' });
});

test('an error-only stream is classified, not treated as advice', () => {
  const out = adapter.interpret({
    stdout: line({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit for this model.' } } }),
    stderr: '',
    code: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'usage_limit');
  assert.match(out.message, /usage limit/);
});

test('an auth error is classified as auth', () => {
  const out = adapter.interpret({
    stdout: line({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'invalid api key' } } }),
    stderr: '',
    code: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'auth');
});

test('a model error is classified as model_unavailable', () => {
  const out = adapter.interpret({
    stdout: line({ type: 'error', error: { name: 'UnknownModelException', data: { message: 'model glm-99 does not exist' } } }),
    stderr: '',
    code: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'model_unavailable');
});

test('an error the CLI recovered from does not invalidate the answer', () => {
  const out = adapter.interpret({
    stdout: line({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'rate limited, retrying' } } })
      + textEvent(JSON.stringify({ summary: 'the answer stands' })),
    stderr: '',
    code: 0,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(out.text), { summary: 'the answer stands' });
  assert.ok(out.usageRaw.errors.length === 1, 'the recovered error stays in the record');
});

test('a run with no JSON at all is a failure, not an empty answer', () => {
  const out = adapter.interpret({ stdout: 'panic: something went wrong\n', stderr: '', code: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'cli_error');
  assert.ok(out.message.length > 0);

  const silent = adapter.interpret({ stdout: '', stderr: '', code: 0 });
  assert.equal(silent.ok, false);
  assert.equal(silent.failureKind, 'invalid_output');
});

test('usage is mapped onto the common record from the last step-finish', () => {
  const rec = adapter.usageRecord({
    tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 7, write: 2 } },
    cost: 0.02,
    steps: 2,
    events: 9,
  });
  assert.equal(rec.input_tokens, 10);
  assert.equal(rec.cached_input_tokens, 7);
  assert.equal(rec.output_tokens, 3);
  assert.equal(rec.cost_usd, 0.02);
  assert.equal(rec.reasoning_tokens, 1);
  assert.equal(rec.turns, 2);
  assert.equal(rec.web_search_requests, null, 'no per-tool web count is reported; none may be guessed');
});

test('usage tolerates a missing or oddly-shaped step-finish', () => {
  for (const raw of [null, undefined, {}, { tokens: null }, { tokens: 'garbage' }]) {
    const rec = adapter.usageRecord(raw);
    assert.equal(rec.input_tokens, null);
    assert.equal(rec.output_tokens, null);
    assert.equal(rec.cost_usd, null);
  }
});

// The point of streaming: a consultation killed at its budget leaves a trail.
test('progress says how far a consultation has got', () => {
  const stream = [
    line({ type: 'step_start', part: { type: 'step-start' } }),
    line({ type: 'tool_use', part: { type: 'tool', tool: 'grep', state: { status: 'running' } } }),
    '{"type":"text","part":{"type":"te',  // a line cut off mid-write, as a kill does
  ].join('');
  const summary = adapter.progress({ stdout: stream });
  assert.match(summary, /2 event\(s\)/);
  assert.match(summary, /grep/);
});

test('progress is null when there is nothing to report', () => {
  assert.equal(adapter.progress({ stdout: '' }), null);
  assert.equal(adapter.progress({ stdout: 'not json at all\n' }), null);
});
