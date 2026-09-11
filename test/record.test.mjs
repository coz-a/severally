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

test('a verdict can be written from a later session, against the round file on disk', async () => {
  const { view } = await completed();
  const later = new JobManager();
  assert.equal(later.jobs.has(view.job_id), false);
  const indexPath = path.join(home, 'history', 'index.jsonl');
  const before = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).length;

  const out = later.record({
    job_id: view.job_id,
    entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Checked a week later.', note: 'Load test ran on Thursday.' }],
    reflection: { delta: 'nothing new', related_item_ids: ['f1'] },
  });
  assert.equal(out.job_id, view.job_id);
  assert.deepEqual(out.record.verdicts, { confirmed: 1 });

  const stored = roundFile(view);
  assert.equal(stored.record.entries[0].verdict, 'confirmed');
  assert.equal(stored.record.entries[0].note, 'Load test ran on Thursday.');
  assert.equal(stored.reflection.delta, 'nothing new');
  assert.equal(stored.result.findings[0].id, 'f1', 'the answer itself must survive the rewrite');
  assert.equal(stored.brief.objective, 'Ship a retry policy that will not amplify an outage.', 'so must the brief');
  const after = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before, 'a later verdict is an edit, not a new consultation');

  // A second write from that later session merges, just as it does in-session.
  later.record({ job_id: view.job_id, entries: [{ id: 'c1', verdict: 'unverified', effect: 'Not yet.' }] });
  assert.equal(roundFile(view).record.entries.length, 2);
});

test('recording against a consultation neither this session nor the history knows is refused', async () => {
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

const prediction = { expected: 'do_not_proceed', worry: 'The write amplification will sink the primary.' };

test('a prediction written when the consultation starts is stored with the round', async () => {
  const { view } = await completed({ prediction });
  const stored = roundFile(view).prediction;
  assert.equal(stored.expected, 'do_not_proceed');
  assert.equal(stored.worry, 'The write amplification will sink the primary.');
  assert.ok(stored.recorded_at, 'the record says when the prediction was written');
  assert.ok(new Date(stored.recorded_at) <= new Date(roundFile(view).finished_at),
    'a prediction is only a prediction if it predates the answer');
});

test('the prediction is never sent to the consultant', async () => {
  const briefDir = fs.mkdtempSync(path.join(home, 'briefs-pred-'));
  process.env.STUB_BRIEF_DIR = briefDir;
  await completed({ prediction });
  const withPrediction = fs.readFileSync(path.join(briefDir, 'codex.txt'), 'utf8');
  await completed();
  const without = fs.readFileSync(path.join(briefDir, 'codex.txt'), 'utf8');
  delete process.env.STUB_BRIEF_DIR;

  assert.doesNotMatch(withPrediction, /write amplification/i, 'the consultant must not see what the lead expects');
  assert.doesNotMatch(withPrediction, /prediction/i);
  // The four stance words are in the response schema either way, so the only
  // assertion that means anything is that the brief did not change at all.
  assert.equal(withPrediction, without, 'a prediction must not alter one byte of what is sent');
});

test('a consultation without a prediction is still a consultation', async () => {
  const { view } = await completed();
  assert.equal(roundFile(view).prediction, null);
});

test('a prediction cannot be written once the answer is in', async () => {
  const { mgr, view } = await completed({ prediction });
  assert.throws(
    () => mgr.record({ job_id: view.job_id, prediction: { expected: 'proceed', worry: 'changed my mind' } }),
    (err) => err.code === 'unknown_field',
  );
  assert.equal(roundFile(view).prediction.expected, 'do_not_proceed', 'the stored prediction is untouched');
});

test('what the answer added is recorded in the lead\'s own words, not as a hit or a miss', async () => {
  const { mgr, view } = await completed({ prediction });
  const out = mgr.record({
    job_id: view.job_id,
    reflection: { delta: 'The retry cap was expected; the autovacuum angle was not.', related_item_ids: ['f1', 'c1'] },
  });
  assert.equal(out.reflection.delta, 'The retry cap was expected; the autovacuum angle was not.');
  assert.deepEqual(out.reflection.related_item_ids, ['f1', 'c1']);
  const stored = roundFile(view).reflection;
  assert.equal(stored.delta, 'The retry cap was expected; the autovacuum angle was not.');
  assert.ok(stored.recorded_at);
});

test('a reflection can only point at points the consultant actually made', async () => {
  const { mgr, view } = await completed({ prediction });
  assert.throws(
    () => mgr.record({ job_id: view.job_id, reflection: { delta: 'x', related_item_ids: ['f4'] } }),
    (err) => err.code === 'unknown_entry_id',
  );
});

test('there is nothing to reflect on when no advice arrived', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ prediction }));
  await finish(mgr, started.job_id);
  assert.throws(
    () => mgr.record({ job_id: started.job_id, reflection: { delta: 'nothing came back' } }),
    (err) => err.code === 'no_result',
  );
});

test('consult_list says whether the prediction and the reflection are there', async () => {
  const { mgr, view } = await completed({ prediction });
  const before = mgr.list().find((j) => j.job_id === view.job_id);
  assert.equal(before.predicted, true);
  assert.equal(before.reflected, false);

  mgr.record({ job_id: view.job_id, reflection: { delta: 'Nothing new; the cap was already my worry.' } });
  const after = mgr.list().find((j) => j.job_id === view.job_id);
  assert.equal(after.reflected, true);
});
