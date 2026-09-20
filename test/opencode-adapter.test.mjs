import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers.mjs';

sandboxEnv();
const adapter = await import('../src/adapters/opencode.mjs');
const { POLICY } = await import('../src/policy.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;
const textEvent = (text) => line({ type: 'text', part: { type: 'text', text, time: { start: 1, end: 2 } } });
const finishEvent = (tokens, cost) => line({ type: 'step_finish', part: { type: 'step-finish', tokens, cost } });

// 2.x runs one-shot consultations on a private server: the default mode
// waits on a shared "background service" whose startup can hang for the full
// two minutes when the machine already runs other opencode services.
// --standalone exists only in 2.x, so the adapter probes `run --help` once
// per process (prepare) and passes the flag only when the CLI offers it --
// 1.18.31 keeps its verified invocation unchanged.
test('prepare() probes --standalone support and buildInvocation follows it', async () => {
  delete process.env.STUB_HELP;
  await adapter.resetProbe?.();
  await adapter.prepare();
  assert.equal(adapter.buildInvocation({}).args.includes('--standalone'), false,
    'a CLI whose help hides --standalone (1.18.31) must not receive it');

  process.env.STUB_HELP = 'standalone';
  try {
    await adapter.resetProbe?.();
    await adapter.prepare();
    assert.ok(adapter.buildInvocation({}).args.includes('--standalone'),
      'a CLI that advertises --standalone (2.x) must run on a private server');
  } finally {
    delete process.env.STUB_HELP;
    await adapter.resetProbe?.();
  }
});

test('the invocation pins print mode, the event stream and the model', () => {
  const inv = adapter.buildInvocation({ workdir: '/tmp/work', schemaPath: '/tmp/schema.json' });
  assert.equal(inv.command, POLICY.targets.opencode.cli);
  assert.deepEqual(inv.args.slice(0, 3), ['run', '--format', 'json']);
  // opencode 2.0 removed --pure (it was accepted through 1.18.31). Passing it
  // now prints a usage dump and exits 0 without running anything, so the flag
  // must be gone rather than tolerated.
  assert.equal(inv.args.includes('--pure'), false, 'opencode 2.x rejects --pure with a usage dump');
  assert.equal(inv.args.indexOf('-m'), inv.args.length - 4, 'the model flag carries the chosen model');
  assert.equal(POLICY.targets.opencode.model, 'zai-coding-plan/glm-5.3');
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
    // session store back. --server is the 2.x form (--attach was 1.x and is
    // gone); both stay forbidden so an older or newer CLI is covered either way.
    '--attach', '--server', '--continue', '-c', '--session', '-s', '--fork',
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

// GLM models append epilogues after the JSON contract ("Done, hope this
// helps!"). The last part still wins as the answer, but the completed parts
// before it are kept so parse-result can fall back to them when the last one
// carries no contract JSON at all.
test('earlier completed text parts are kept for a fallback pass', () => {
  const contract = JSON.stringify({ summary: 'the real answer' });
  const out = adapter.interpret({
    stdout: textEvent('Interim prose.')
      + textEvent(contract)
      + textEvent('Done. Hope this helps!')
      + finishEvent({}, null),
    stderr: '',
    code: 0,
  });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'Done. Hope this helps!');
  assert.deepEqual(out.earlierTextParts, ['Interim prose.', contract]);
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

// opencode 2.x renamed the error event fields: {name, data:{message}} became
// {type, message}, and `run` now exits 0 even on provider errors. The message
// must come out as the bare text -- a JSON dump is what the lead reads when
// the classification fails, and it garbles the record either way.
test('a 2.x-shaped error event yields the bare message and the right kind', () => {
  const auth = adapter.interpret({
    stdout: line({ type: 'error', error: { type: 'provider.auth', message: 'not logged in: invalid api key (401)' } }),
    stderr: '',
    code: 0,
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.failureKind, 'auth');
  assert.equal(auth.message, 'not logged in: invalid api key (401)');

  const model = adapter.interpret({
    stdout: line({ type: 'error', error: { type: 'provider.no-route', message: 'Model unavailable: zai-coding-plan/glm-5.3' } }),
    stderr: '',
    code: 0,
  });
  assert.equal(model.ok, false);
  assert.equal(model.failureKind, 'model_unavailable');
  assert.equal(model.message, 'Model unavailable: zai-coding-plan/glm-5.3');
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

// 2.x exits 0 even on provider errors, so the exit code cannot be the signal.
// What decides is order: an error AFTER the final text part means the answer
// never followed the failure -- the text before it was interim prose (planning
// aloud, a status note), and treating it as the answer turns an auth or quota
// failure into a misleading invalid_output retry.
test('an error after the final text part fails the job, even on exit 0', () => {
  const out = adapter.interpret({
    stdout: textEvent('Planning: I will check the schema next.')
      + line({ type: 'error', error: { type: 'provider.auth', message: 'not logged in: invalid api key (401)' } }),
    stderr: '',
    code: 0,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'auth');
  assert.match(out.message, /not logged in/);
});

test('an error after the final answer with a nonzero exit fails too', () => {
  const out = adapter.interpret({
    stdout: textEvent(JSON.stringify({ summary: 'looks done' }))
      + line({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit for this model.' } } }),
    stderr: '',
    code: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'usage_limit');
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

// -- Truncation (f4 from the 2.x review): stdout is capped at rawCaptureMax;
// when the cap hit before the consultation finished, the final answer event
// may be missing entirely and the LAST completed text part is then interim
// prose. A finished consultation always writes a step-finish after its final
// text part, so: truncated + no step-finish after the last text = the answer
// never arrived -> explicit failure, never a silently wrong answer. Truncated
// but properly finished = the cap only ate post-answer noise; the answer
// stands and the record keeps the truncated flag.
test('a truncated stream that never finished fails instead of returning interim prose', () => {
  const out = adapter.interpret({
    stdout: textEvent('Working on it, the findings so far are...')
      + line({ type: 'step_start', part: { type: 'step-start' } }),
    stderr: '',
    code: 0,
    truncated: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'invalid_output');
  assert.match(out.message, /truncat/i);
});

test('a truncated stream that did finish keeps the answer and records the flag', () => {
  const out = adapter.interpret({
    stdout: textEvent(JSON.stringify({ summary: 'done' })) + finishEvent({}, null),
    stderr: '',
    code: 0,
    truncated: true,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(out.text), { summary: 'done' });
  assert.equal(out.usageRaw.truncated, true);
});

// A finish after an EARLIER text part must not vouch for a LATER one: the
// sequence text -> finish -> text(cut off by the capture cap) means the
// consultation kept working after that finish and never completed again.
test('a truncated stream fails when a later text part has no finish after it', () => {
  const out = adapter.interpret({
    stdout: textEvent('step one prose') + finishEvent({}, null) + textEvent('step two, cut off mid-an'),
    stderr: '',
    code: 0,
    truncated: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'invalid_output');
});

// The finish-after-text reset covers a captured LATER text; the remaining
// hole is work that continued past a finish and was cut before any new text
// arrived (text A -> finish -> step 2 starts -> capture cut). The final
// answer never arrived, so under truncation only a stream that ENDS on a
// step-finish may be trusted.
test('a truncated stream fails when work continued past the last finish', () => {
  const out = adapter.interpret({
    stdout: textEvent(JSON.stringify({ summary: 'step one answer' })) + finishEvent({}, null)
      + line({ type: 'step_start', part: { type: 'step-start' } }),
    stderr: '',
    code: 0,
    truncated: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failureKind, 'invalid_output');
});

// A capability probe that FAILED (spawn error, timeout, nonzero exit) must
// not be cached as "flag unsupported": on a 2.x install that would pin every
// later job to the shared-service route that hangs. Only a successful help
// invocation may cache -- and only a zero exit counts, so a diagnostic line
// that happens to mention --standalone cannot establish support.
test('a transient probe failure is not cached, and a nonzero-exit help proves nothing', async () => {
  process.env.STUB_HELP = 'fail';
  await adapter.resetProbe();
  await adapter.prepare();
  assert.equal(adapter.buildInvocation({}).args.includes('--standalone'), false,
    'a failed probe yields no flag for this job');
  process.env.STUB_HELP = 'standalone';
  await adapter.prepare(); // no resetProbe: the failure must not have been cached
  assert.ok(adapter.buildInvocation({}).args.includes('--standalone'),
    'a later job must re-probe and find the flag');
  delete process.env.STUB_HELP;
  await adapter.resetProbe();
});

// Both CLI generations exit 0 on every observed success; a nonzero exit with
// a usable-looking text part means the CLI crashed around it, and accepting
// the text would dress a crashed consultation up as advice.
test('a nonzero exit fails the job even when a completed answer exists', () => {
  const out = adapter.interpret({
    stdout: textEvent(JSON.stringify({ summary: 'looks done' })) + finishEvent({}, null),
    stderr: 'fatal: bun panicked',
    code: 1,
  });
  assert.equal(out.ok, false);
  assert.ok(out.failureKind);
});

test('an error before the answer with a nonzero exit fails too, not recovers', () => {
  const out = adapter.interpret({
    stdout: line({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'rate limited, retrying' } } })
      + textEvent(JSON.stringify({ summary: 'the answer stands' }))
      + finishEvent({}, null),
    stderr: '',
    code: 1,
  });
  assert.equal(out.ok, false);
});

test('an untruncated run sets no truncated flag', () => {
  const out = adapter.interpret({
    stdout: textEvent(JSON.stringify({ summary: 'done' })) + finishEvent({}, null),
    stderr: '',
    code: 0,
    truncated: false,
  });
  assert.equal(out.ok, true);
  assert.equal(out.usageRaw.truncated, false);
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

// The 2.x recovery seam: a no-route failure on a model whose provider has an
// api entry in the copied auth.json is exactly the "2.x ignores auth.json"
// case, and one seed+retry fixes it. Everything else -- auth rejections,
// usage limits, invalid output -- must not trigger a respawn.
test('recoverAuthFailure seeds and reports readiness only for a no-route failure', () => {
  const noRoute = { ok: false, failureKind: 'model_unavailable' };
  let seededFor = null;
  const sandbox = { seed: (provider) => { seededFor = provider; return true; } };
  assert.equal(
    adapter.recoverAuthFailure({ interpreted: noRoute, sandbox, model: 'zai-coding-plan/glm-5.3' }),
    true,
    'a no-route failure with an api entry is seedable',
  );
  assert.equal(seededFor, 'zai-coding-plan');

  for (const interpreted of [{ ok: false, failureKind: 'auth' }, { ok: false, failureKind: 'usage_limit' }, { ok: true }]) {
    assert.equal(adapter.recoverAuthFailure({ interpreted, sandbox, model: 'zai-coding-plan/glm-5.3' }), false);
  }
  assert.equal(seededFor, 'zai-coding-plan', 'non-seedable failures must not touch the sandbox');

  // A model without a provider prefix, or a seed that found nothing to
  // write, must not promise a retry.
  assert.equal(adapter.recoverAuthFailure({ interpreted: noRoute, sandbox, model: 'local-model' }), false);
  const refusing = { seed: () => false };
  assert.equal(adapter.recoverAuthFailure({ interpreted: noRoute, sandbox: refusing, model: 'zai-coding-plan/glm-5.3' }), false);
});
