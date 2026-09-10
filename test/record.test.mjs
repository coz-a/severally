import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest, waitFor } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');

const finish = async (mgr, jobId) => {
  await mgr.jobs.get(jobId).promise;
  return mgr.view(jobId);
};

const roundFile = (view) => JSON.parse(fs.readFileSync(
  path.join(home, 'history', view.chain_id, `round-${String(view.round).padStart(2, '0')}.json`),
  'utf8',
));

const completed = async (over = {}) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest(over));
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  return { mgr, view };
};

test('the round file keeps the brief that was sent, not only the question', async () => {
  const { view } = await completed();
  const brief = roundFile(view).brief;
  assert.equal(brief.objective, 'Ship a retry policy that will not amplify an outage.');
  assert.deepEqual(brief.constraints, ['No new infrastructure', 'Must stay in the existing service']);
  assert.deepEqual(brief.facts, ['The client retries 5 times with 100ms fixed backoff.']);
  assert.match(brief.proposal, /Keep 5 retries but add jitter/);
  assert.equal(brief.artifacts.length, 1);
  assert.equal(brief.artifacts[0].name, 'retry.ts');
  assert.match(brief.artifacts[0].excerpt, /for \(let i=0/);
  assert.deepEqual(brief.success_criteria, ['A concrete failure scenario or a clear all-clear']);
});

test('the stored brief is masked the same way the sent one was', async () => {
  const { view } = await completed({
    context: {
      facts: ['The worker authenticates with API_KEY=sk-proj-abcdefghijklmnopqrstuvwx'],
      proposal: 'Rotate it on deploy, because the value is baked into the image.',
    },
  });
  const brief = roundFile(view).brief;
  assert.doesNotMatch(JSON.stringify(brief), /sk-proj-abcdefghijklmnopqrstuvwx/);
  assert.match(brief.facts[0], /\[REDACTED\]/);
});

test('a consultation that never produced an answer still records what was asked', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'failed');
  assert.equal(roundFile(view).brief.objective, 'Ship a retry policy that will not amplify an outage.');
});

test('the lead\'s verdict on a finding is stored as written and reaches the round file', async () => {
  const { mgr, view } = await completed();
  const out = mgr.record({
    job_id: view.job_id,
    entries: [
      { id: 'f1', verdict: 'confirmed', effect: 'Capped the retries at 3.', note: 'Reproduced with a 30s outage.' },
      { id: 'c1', verdict: 'unverified', effect: 'Load test not run yet.' },
    ],
  });
  assert.equal(out.job_id, view.job_id);
  assert.equal(out.record.entries.length, 2);
  assert.deepEqual(out.record.verdicts, { confirmed: 1, unverified: 1 });

  const stored = roundFile(view).record;
  assert.equal(stored.entries[0].id, 'f1');
  assert.equal(stored.entries[0].verdict, 'confirmed');
  assert.equal(stored.entries[0].effect, 'Capped the retries at 3.');
  assert.equal(stored.entries[0].note, 'Reproduced with a 30s outage.');
  assert.ok(stored.entries[0].recorded_at, 'each entry carries when it was written');
  assert.equal(mgr.view(view.job_id).record.entries.length, 2);
});

test('coverage is counted, never inferred: unrecorded points stay unrecorded', async () => {
  const { mgr, view } = await completed();
  const out = mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'not_applicable' }] });
  assert.deepEqual(out.record.coverage, { recordable: 3, recorded: 1 });
  assert.deepEqual(out.record.unrecorded, ['u1', 'c1']);
});

test('a verdict must name a point the consultant actually made', async () => {
  const { mgr, view } = await completed();
  assert.throws(
    () => mgr.record({ job_id: view.job_id, entries: [{ id: 'f7', verdict: 'confirmed' }] }),
    (err) => err.code === 'unknown_entry_id' && /f1/.test(err.message),
  );
});

test('a verdict outside the four words is refused rather than reinterpreted', async () => {
  const { mgr, view } = await completed();
  assert.throws(
    () => mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'adopted' }] }),
    (err) => err.code === 'invalid_verdict' && /not_applicable/.test(err.message),
  );
});

test('recording the same id again replaces that verdict and leaves the others alone', async () => {
  const { mgr, view } = await completed();
  mgr.record({ job_id: view.job_id, entries: [
    { id: 'f1', verdict: 'unverified' },
    { id: 'u1', verdict: 'unverifiable', effect: 'No dashboard access.' },
  ] });
  const out = mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Measured.' }] });
  assert.equal(out.record.entries.length, 2);
  const f1 = out.record.entries.find((e) => e.id === 'f1');
  assert.equal(f1.verdict, 'confirmed');
  assert.equal(f1.effect, 'Measured.');
  assert.equal(out.record.entries.find((e) => e.id === 'u1').verdict, 'unverifiable');
});

test('there is nothing to record against a consultation that produced no advice', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  await finish(mgr, started.job_id);
  assert.throws(
    () => mgr.record({ job_id: started.job_id, entries: [{ id: 'f1', verdict: 'confirmed' }] }),
    (err) => err.code === 'no_result',
  );
});

test('recording a verdict masks credentials and does not add a second history line', async () => {
  const { mgr, view } = await completed();
  const indexPath = path.join(home, 'history', 'index.jsonl');
  const before = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).length;
  mgr.record({
    job_id: view.job_id,
    entries: [{ id: 'f1', verdict: 'confirmed', note: 'Checked with API_KEY=sk-proj-abcdefghijklmnopqrstuvwx' }],
  });
  const after = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before, 'a verdict is an update to the round, not a new round');
  assert.doesNotMatch(roundFile(view).record.entries[0].note, /sk-proj-abcdefghijklmnopqrstuvwx/);
});

test('consult_list says which consultations have a verdict written and what the verdicts were', async () => {
  const { mgr, view } = await completed();
  const before = mgr.list().find((j) => j.job_id === view.job_id);
  assert.equal(before.recorded, false);
  assert.equal(before.verdicts, null);

  mgr.record({ job_id: view.job_id, entries: [
    { id: 'f1', verdict: 'confirmed' },
    { id: 'c1', verdict: 'confirmed' },
    { id: 'u1', verdict: 'unverified' },
  ] });
  const after = mgr.list().find((j) => j.job_id === view.job_id);
  assert.equal(after.recorded, true);
  assert.deepEqual(after.verdicts, { confirmed: 2, unverified: 1 });
});

test('recording against a consultation this session never saw is refused', async () => {
  const { mgr } = await completed();
  assert.throws(
    () => mgr.record({ job_id: 'job_nope', entries: [{ id: 'f1', verdict: 'confirmed' }] }),
    (err) => err.code === 'unknown_job',
  );
});

test('a completed consultation points at the record as the way it closes', async () => {
  const { view } = await completed();
  assert.match(view.next_step, /consult_record/);
});

test('once every point carries a verdict, the consultation stops asking to be closed', async () => {
  const { mgr, view } = await completed();
  mgr.record({ job_id: view.job_id, entries: [
    { id: 'f1', verdict: 'confirmed' },
    { id: 'u1', verdict: 'unverifiable' },
    { id: 'c1', verdict: 'unverified', effect: 'Deferred to the load-test window.' },
  ] });
  assert.doesNotMatch(mgr.view(view.job_id).next_step, /consult_record/);
});
