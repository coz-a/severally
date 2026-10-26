import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const masking = await import('../src/redact.mjs');
const { normalizeResult } = await import('../src/parse-result.mjs');
const { JobManager, pointsOf } = await import('../src/jobs.mjs');
const { exportChain } = await import('../src/export.mjs');
const store = await import('../src/store.mjs');

const observation = { files: true, brief: true, result: true };

test('a value-free synthetic reproduction remains executable after answer masking', () => {
  const source = `const field = 'api_key'; const sample = 'SYNTHETIC_ONLY';
const input = Object.fromEntries([[field, sample]]); const output = redact(input);
({ field_present: Object.hasOwn(output, field), original_value_retained: Object.is(output[field], sample) });`;
  const safe = masking.redact(source);
  assert.equal(safe, source);
  const facts = vm.runInNewContext(safe, { redact: masking.redact });
  assert.equal(facts.field_present, true);
  assert.equal(facts.original_value_retained, false);
});

test('redaction reports actual replacements without keeping original values or treating markers as equality', () => {
  const one = masking.redactWithReport({ api_key: 'synthetic-one', public: 42 });
  const two = masking.redactWithReport({ api_key: 'synthetic-two', public: 42 });
  assert.deepEqual(one, { value: { api_key: '[REDACTED]', public: 42 }, redacted: true });
  assert.deepEqual(two.value, one.value);
  assert.deepEqual(masking.redactWithReport(one.value), { value: one.value, redacted: false });
  assert.deepEqual(masking.redactWithReport('public example'), { value: 'public example', redacted: false });
  // Reproducible structural counterexample: compare field presence, not masked values.
  assert.ok(Object.hasOwn(masking.redact({ api_key: 'synthetic-one' }), 'api_key'));
  assert.ok(!Object.hasOwn(masking.redact({ public: 42 }), 'api_key'));
  assert.ok(!JSON.stringify(one).includes('synthetic-one'));
});

test('normalization observes parsed object masking and marks stages it did not observe as unknown', () => {
  const answer = { summary: 'Structural finding', api_key: 'synthetic-one' };
  for (const raw of [answer, JSON.stringify(answer)]) {
    const out = normalizeResult(raw);
    assert.deepEqual(out.quality.redaction, { files: null, brief: null, result: true });
    assert.ok(!JSON.stringify(out).includes('synthetic-one'));
  }
  assert.equal(normalizeResult({ summary: 'Public answer' }).quality.redaction.result, false);
});

test('file, brief and output replacement observations survive comparison, restart, points and export', async (t) => {
  const fixture = path.join(home, 'fixture.js');
  fs.writeFileSync(fixture, 'const API_KEY="synthetic-one";\n');
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_ANSWER_PATCH = JSON.stringify({
    summary: 'Sensitive field remained present; remove it before sending.',
    api_key: 'synthetic-two',
  });
  t.after(() => {
    delete process.env.STUB_ANSWER_PATCH;
  });
  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      target: undefined,
      targets: ['codex', 'claude-code'],
      context: { proposal: 'Strip sensitive fields.', facts: ['API_KEY="synthetic-brief"'], expose_paths: [fixture] },
    }),
  );
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  const view = mgr.groupView(started.group_id);
  for (const column of view.comparison.by_target) {
    const full = mgr.view(column.job_id, { detail: 'full' });
    const expected = { ...observation, result: column.target === 'codex' };
    assert.equal(full.status, 'completed');
    assert.deepEqual(full.quality.redaction, expected);
    assert.equal(full.brief.expose_paths.redacted, true);
    assert.deepEqual(column.redaction, expected);
    assert.deepEqual(pointsOf(full, ['f1']).redaction, expected);
    assert.match(full.quality.caveat, /redact|mask/i);
    const reloaded = new JobManager().view(column.job_id);
    assert.deepEqual(reloaded.quality.redaction, expected);
    assert.deepEqual(reloaded.brief.redaction, { files: true, brief: true });
  }
  const markdown = exportChain({ group_id: started.group_id }).markdown;
  assert.match(markdown, /files=true, brief=true, result=true/);
  assert.match(markdown, /equality|equal/i);
  assert.ok(!markdown.includes('synthetic-one'));
});

test('legacy observations are explicitly unknown in comparison and export', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await Promise.all(s.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  for (const j of s.jobs) {
    const live = mgr.jobs.get(j.job_id);
    delete live.quality.redaction;
    delete live.brief.redaction;
    store.persistRound({ ...store.loadRound(j.job_id), quality: live.quality, brief: live.brief }, { appendIndex: false });
  }
  for (const c of new JobManager().groupView(s.group_id).comparison.by_target) {
    assert.deepEqual(c.redaction, { files: null, brief: null, result: null });
  }
  assert.match(exportChain({ group_id: s.group_id }).markdown, /files=unknown, brief=unknown, result=unknown/);
});
