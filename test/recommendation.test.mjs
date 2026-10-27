import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

sandboxEnv();
const { normalizeResult } = await import('../src/parse-result.mjs');
const { CONSULT_RESULT_SCHEMA } = await import('../src/result-schema.mjs');
const { JobManager } = await import('../src/jobs.mjs');
const store = await import('../src/store.mjs');
const { exportChain } = await import('../src/export.mjs');

test('the output contract requests a concise recommendation separate from stance', () => {
  assert.ok(CONSULT_RESULT_SCHEMA.required.includes('recommendation'));
  assert.equal(CONSULT_RESULT_SCHEMA.properties.recommendation.type, 'string');
  const current = normalizeResult({ summary: 'Summary', stance: 'proceed', recommendation: 'Use a bounded queue.' });
  assert.equal(current.result.recommendation, 'Use a bounded queue.');
  const old = normalizeResult({ summary: 'Use a bounded queue.', stance: 'proceed' });
  assert.equal(old.result.recommendation, null);
  assert.ok(old.quality.missing_sections.includes('recommendation'));
});

test('equal stances retain different recommendations and old answers remain explicitly undeclared', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code', 'antigravity'] }));
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  const recommendations = ['Use a token bucket.', 'Use a fixed retry budget.', undefined];
  for (const [i, entry] of started.jobs.entries()) {
    const job = mgr.jobs.get(entry.job_id);
    job.result.stance = i === 2 ? 'do_not_proceed' : 'proceed';
    if (recommendations[i]) job.result.recommendation = recommendations[i];
    else delete job.result.recommendation;
    store.persistRound({ ...store.loadRound(job.job_id), result: job.result }, { appendIndex: false });
  }
  const columns = new JobManager().groupView(started.group_id).comparison.by_target;
  assert.deepEqual(
    columns.map((c) => c.stance),
    ['proceed', 'proceed', 'do_not_proceed'],
  );
  assert.deepEqual(
    columns.map((c) => c.recommendation),
    [...recommendations.slice(0, 2), null],
  );
  const markdown = exportChain({ group_id: started.group_id }).markdown;
  assert.match(markdown, /recommendation: Use a token bucket\./);
  assert.match(markdown, /recommendation: Use a fixed retry budget\./);
  assert.match(markdown, /recommendation: not declared/);
});
