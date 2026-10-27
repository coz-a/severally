import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { normalizeResult, OutputError } = await import('../src/parse-result.mjs');
const { exportChain } = await import('../src/export.mjs');
const { loadRound } = await import('../src/store.mjs');

test('normalization errors mask structured credentials before including rejected data in their detail', () => {
  for (const input of [
    { api_key: 'synthetic-example-only', nested: [{ password: 1234 }] },
    JSON.stringify({ api_key: 'synthetic-example-only', nested: [{ password: 1234 }] }),
  ]) {
    assert.throws(
      () => normalizeResult(input),
      (err) => {
        assert.ok(err instanceof OutputError);
        const detail = JSON.parse(err.detail);
        assert.equal(detail.api_key, '[REDACTED]');
        assert.equal(detail.nested[0].password, '[REDACTED]');
        return true;
      },
    );
  }
});

test('brief, result, verification record, reloaded history and export retain masking at their boundaries', async (t) => {
  const secret = 'synthetic-example-only';
  const text = JSON.stringify({ api_key: secret, primary_key: 'organization_id' });
  const sent = path.join(home, 'sent-brief.txt');
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_BRIEF_OUT = sent;
  process.env.STUB_ANSWER_PATCH = JSON.stringify({
    summary: text,
    findings: [{ point: 'Credential field remained present', grounds: text, severity: 'high' }],
  });
  t.after(() => {
    delete process.env.STUB_BRIEF_OUT;
    delete process.env.STUB_ANSWER_PATCH;
  });

  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      question: `Review this synthetic credential fixture: ${text}`,
      context: {
        facts: [text],
        proposal: 'Remove credential fields.',
        artifacts: [{ name: 'fixture', kind: 'data', excerpt: text }],
      },
    }),
  );
  await mgr.jobs.get(started.job_id).promise;
  const view = mgr.view(started.job_id, { detail: 'full' });
  assert.equal(view.status, 'completed');

  mgr.record({
    job_id: view.job_id,
    entries: [{ id: 'f1', verdict: 'confirmed', note: text, effect: text }],
    reflection: { delta: text, related_item_ids: ['f1'] },
  });
  const reloaded = loadRound(view.job_id);
  const roundPath = path.join(home, 'history', view.chain_id, 'round-01.json');
  const markdown = exportChain({ chain_id: view.chain_id }).markdown;
  const stages = {
    sent_brief: fs.readFileSync(sent, 'utf8'),
    saved_brief: JSON.stringify(view.brief),
    result: JSON.stringify(view.result),
    record: JSON.stringify(reloaded.record),
    reflection: JSON.stringify(reloaded.reflection),
    history: fs.readFileSync(roundPath, 'utf8'),
    reloaded_view: JSON.stringify(new JobManager().view(view.job_id, { detail: 'full' })),
    export: markdown,
  };
  for (const [stage, value] of Object.entries(stages)) {
    assert.ok(!value.includes(secret), `${stage} leaked the synthetic credential`);
    assert.match(value, /REDACTED/, stage);
    assert.match(value, /organization_id/, `${stage} lost the ordinary identifier`);
  }
});
