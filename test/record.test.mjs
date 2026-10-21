import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandboxEnv, reviewRequest, waitFor } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');

const finish = async (mgr, jobId) => {
  await mgr.jobs.get(jobId).promise;
  return mgr.view(jobId);
};

const roundFile = (view) =>
  JSON.parse(
    fs.readFileSync(path.join(home, 'history', view.chain_id, `round-${String(view.round).padStart(2, '0')}.json`), 'utf8'),
  );

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

test("the lead's verdict on a finding is stored as written and reaches the round file", async () => {
  const { mgr, view } = await completed();
  const out = mgr.record({
    job_id: view.job_id,
    entries: [
      { id: 'f1', verdict: 'confirmed', effect: 'Capped the retries at 3.', note: 'Reproduced with a 30s outage.' },
      { id: 'c1', verdict: 'unverified', effect: 'Load test not run yet.' },
    ],
  });
  assert.equal(out.job_id, view.job_id);
  // The answer counts what was saved; it does not echo the entries back.
  assert.equal(out.record.entries, undefined);
  assert.deepEqual(out.record.verdicts, { confirmed: 1, unverified: 1 });
  assert.deepEqual(out.record.coverage, { recordable: 3, recorded: 2 });

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
  assert.deepEqual(mgr.view(view.job_id).record.unrecorded, ['u1', 'c1']);
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
  mgr.record({
    job_id: view.job_id,
    entries: [
      { id: 'f1', verdict: 'unverified' },
      { id: 'u1', verdict: 'unverifiable', effect: 'No dashboard access.' },
    ],
  });
  mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Measured.' }] });
  const { record } = mgr.view(view.job_id);
  assert.equal(record.entries.length, 2);
  const f1 = record.entries.find((e) => e.id === 'f1');
  assert.equal(f1.verdict, 'confirmed');
  assert.equal(f1.effect, 'Measured.');
  assert.equal(record.entries.find((e) => e.id === 'u1').verdict, 'unverifiable');
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

  mgr.record({
    job_id: view.job_id,
    entries: [
      { id: 'f1', verdict: 'confirmed' },
      { id: 'c1', verdict: 'confirmed' },
      { id: 'u1', verdict: 'unverified' },
    ],
  });
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
  mgr.record({
    job_id: view.job_id,
    entries: [
      { id: 'f1', verdict: 'confirmed' },
      { id: 'u1', verdict: 'unverifiable' },
      { id: 'c1', verdict: 'unverified', effect: 'Deferred to the load-test window.' },
    ],
  });
  assert.doesNotMatch(mgr.view(view.job_id).next_step, /consult_record/);
});

const prediction = { expected: 'do_not_proceed', worry: 'The write amplification will sink the primary.' };

test('a prediction written when the consultation starts is stored with the round', async () => {
  const { view } = await completed({ prediction });
  const stored = roundFile(view).prediction;
  assert.equal(stored.expected, 'do_not_proceed');
  assert.equal(stored.worry, 'The write amplification will sink the primary.');
  assert.ok(stored.recorded_at, 'the record says when the prediction was written');
  assert.ok(
    new Date(stored.recorded_at) <= new Date(roundFile(view).finished_at),
    'a prediction is only a prediction if it predates the answer',
  );
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

test("what the answer added is recorded in the lead's own words, not as a hit or a miss", async () => {
  const { mgr, view } = await completed({ prediction });
  const out = mgr.record({
    job_id: view.job_id,
    reflection: { delta: 'The retry cap was expected; the autovacuum angle was not.', related_item_ids: ['f1', 'c1'] },
  });
  assert.equal(out.reflection_saved, true);
  assert.deepEqual(mgr.view(view.job_id).reflection.related_item_ids, ['f1', 'c1']);
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

test('a verdict that could not reach the history is reported, not dropped', async () => {
  const { mgr, view } = await completed();
  const file = path.join(home, 'history', view.chain_id, `round-${String(view.round).padStart(2, '0')}.json`);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(
    () => mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'confirmed' }] }),
    (e) => e.code === 'record_not_saved',
  );
});

// A completed job kept by its owner must not hide later sessions' checks.
test('the owning session reads later verdicts in views, list, comparison, export and the next brief without saving', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const group = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await Promise.all(group.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  const jobId = group.jobs[0].job_id;
  const live = mgr.jobs.get(jobId);
  const promise = live.promise;
  const cancelFns = live._cancelFns;
  new JobManager().record({
    job_id: jobId,
    entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Verified by the other session.' }],
    reflection: { delta: 'The other session found the missing bound.', related_item_ids: ['f1'] },
  });
  const store = await import('../src/store.mjs');
  const file = store.roundPath(live.chain_id, live.round);
  const before = fs.statSync(file, { bigint: true }).mtimeNs;
  const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(mgr.view(jobId).record?.entries[0].verdict, 'confirmed');
  assert.equal(mgr.view(jobId).reflection.delta, 'The other session found the missing bound.');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before, 'view does not rewrite the round');
  new JobManager().record({ job_id: jobId, entries: [{ id: 'u1', verdict: 'unverifiable' }] });
  const listed = mgr.list({ limit: 100 }).find((j) => j.job_id === jobId);
  assert.deepEqual(listed.verdicts, { confirmed: 1, unverifiable: 1 });
  assert.equal(listed.reflected, true);
  new JobManager().record({ job_id: jobId, entries: [{ id: 'c1', verdict: 'unverified' }] });
  const finalBytes = fs.readFileSync(file, 'utf8');
  const finalMtime = fs.statSync(file, { bigint: true }).mtimeNs;
  assert.equal(mgr.groupView(group.group_id).comparison.by_target[0].points_without_verdict, 0);
  const { exportChain } = await import('../src/export.mjs');
  const { markdown } = exportChain({ chain_id: live.chain_id });
  assert.match(markdown, /Verified by the other session\./);
  assert.match(markdown, /The other session found the missing bound\./);
  assert.equal(fs.readFileSync(file, 'utf8'), finalBytes);
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, finalMtime, 'reads do not rewrite the round');
  assert.equal(live.promise, promise, 'process controls remain attached');
  assert.equal(live._cancelFns, cancelFns);

  // Update again after the owner's reads: the follow-up must refresh on its own.
  new JobManager().record({
    job_id: jobId,
    entries: [{ id: 'f1', verdict: 'not_applicable', effect: 'Rechecked after the owner read.' }],
  });
  const briefDir = fs.mkdtempSync(path.join(home, 'briefs-later-record-'));
  process.env.STUB_BRIEF_DIR = briefDir;
  try {
    const followup = mgr.start(reviewRequest({ followup_to: jobId }));
    await mgr.jobs.get(followup.job_id).promise;
    const brief = fs.readFileSync(path.join(briefDir, 'codex.txt'), 'utf8');
    assert.match(brief, /not_applicable/);
    assert.match(brief, /Rechecked after the owner read\./);
    assert.match(brief, /The other session found the missing bound\./);
    assert.match(brief, /r1\.f1/);
  } finally {
    delete process.env.STUB_BRIEF_DIR;
  }
});

// Pause each writer after its actual disk read. On the fixed path writer B
// instead reaches the lock; release A then, so the barrier never holds a lock
// while waiting for a second reader that correctly cannot enter it.
async function concurrentRecords(t, view, first, second) {
  const store = await import('../src/store.mjs');
  const file = store.roundPath(view.chain_id, view.round);
  const gates = fs.mkdtempSync(path.join(home, 'record-race-'));
  const children = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  });
  const launch = (name, input) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import fs from 'node:fs';
        const { JobManager } = await import(${JSON.stringify(new URL('../src/jobs.mjs', import.meta.url).href)});
        const store = await import(${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)});
        const file = ${JSON.stringify(file)}, gates = ${JSON.stringify(gates)}, name = ${JSON.stringify(name)};
        const mgr = new JobManager();
        mgr.jobs.set(${JSON.stringify(view.job_id)}, store.loadRound(${JSON.stringify(view.job_id)}));
        const read = fs.readFileSync, mkdir = fs.mkdirSync;
        let paused = false;
        fs.readFileSync = function(p, ...args) {
          const value = read.call(this, p, ...args);
          if (String(p) === file && !paused) {
            paused = true;
            fs.writeFileSync(gates + '/read-' + name, '');
            const until = Date.now() + 10000;
            while (!fs.existsSync(gates + '/release-' + name)) {
              if (Date.now() > until) throw new Error('reader barrier timed out');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          }
          return value;
        };
        fs.mkdirSync = function(p, ...args) {
          try { return mkdir.call(this, p, ...args); }
          catch (e) {
            if (String(p) === file + '.lock' && e.code === 'EEXIST') fs.writeFileSync(gates + '/blocked-' + name, '');
            throw e;
          }
        };
        try {
          const saved = mgr.record(${JSON.stringify({ job_id: view.job_id, ...input })});
          console.log(JSON.stringify(saved));
        } catch (e) { console.error(e.stack); process.exitCode = 1; }
      `,
      ],
      { env: process.env },
    );
    children.push(child);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
    return { child, exited };
  };
  const a = launch('a', first);
  await waitFor(() => fs.existsSync(path.join(gates, 'read-a')), { timeoutMs: 5000 });
  const b = launch('b', second);
  await waitFor(() => fs.existsSync(path.join(gates, 'read-b')) || fs.existsSync(path.join(gates, 'blocked-b')), {
    timeoutMs: 5000,
  });
  fs.writeFileSync(path.join(gates, 'release-a'), '');
  const savedA = await a.exited;
  fs.writeFileSync(path.join(gates, 'release-b'), '');
  const savedB = await b.exited;
  for (const result of [savedA, savedB]) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).job_id, view.job_id);
  }
  return roundFile(view);
}

test('two processes updating different IDs preserve both successes, prior IDs and the concurrent reflection', async (t) => {
  const { mgr, view } = await completed();
  mgr.record({ job_id: view.job_id, entries: [{ id: 'c1', verdict: 'unverified' }] });
  const saved = await concurrentRecords(
    t,
    view,
    { entries: [{ id: 'f1', verdict: 'confirmed' }], reflection: { delta: 'Concurrent reflection.', related_item_ids: ['f1'] } },
    { entries: [{ id: 'u1', verdict: 'unverifiable' }] },
  );
  assert.deepEqual(
    saved.record.entries.map((e) => [e.id, e.verdict]),
    [
      ['f1', 'confirmed'],
      ['u1', 'unverifiable'],
      ['c1', 'unverified'],
    ],
  );
  assert.equal(saved.reflection.delta, 'Concurrent reflection.');
  assert.equal(saved.result.findings[0].point, 'Retry storm risk');
  assert.match(saved.brief.proposal, /Keep 5 retries/);
  const index = fs
    .readFileSync(path.join(home, 'history', 'index.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.includes(view.job_id));
  assert.equal(index.length, 1);
});

test('two processes updating the same ID keep the value saved last under the lock', async (t) => {
  const { view } = await completed();
  const saved = await concurrentRecords(
    t,
    view,
    { entries: [{ id: 'f1', verdict: 'confirmed' }] },
    { entries: [{ id: 'f1', verdict: 'not_applicable' }] },
  );
  assert.deepEqual(
    saved.record.entries.map((e) => [e.id, e.verdict]),
    [['f1', 'not_applicable']],
  );
});

test('a taken record lock fails within a bounded wait and retains only saved values', async () => {
  const { mgr, view } = await completed();
  new JobManager().record({ job_id: view.job_id, entries: [{ id: 'u1', verdict: 'unverifiable' }] });
  const store = await import('../src/store.mjs');
  const file = store.roundPath(view.chain_id, view.round);
  const before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.lock`);
  const started = Date.now();
  try {
    assert.throws(
      () =>
        mgr.record({
          job_id: view.job_id,
          entries: [{ id: 'f1', verdict: 'confirmed' }],
          reflection: { delta: 'Must not survive a failure.' },
        }),
      (e) => e.code === 'record_not_saved',
    );
    assert.ok(Date.now() - started < 5000, 'lock contention cannot wait indefinitely');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(mgr.jobs.get(view.job_id).record?.entries.some((e) => e.id === 'f1') ?? false, false);
    assert.equal(mgr.jobs.get(view.job_id).reflection, null);
    assert.equal(mgr.view(view.job_id).record.entries[0].id, 'u1');
  } finally {
    fs.rmSync(`${file}.lock`, { recursive: true, force: true });
  }
});

test('a failed atomic replacement keeps successful verdicts and removes unsaved memory and temporary files', async (t) => {
  const { mgr, view } = await completed();
  new JobManager().record({ job_id: view.job_id, entries: [{ id: 'u1', verdict: 'unverifiable' }] });
  const store = await import('../src/store.mjs');
  const file = store.roundPath(view.chain_id, view.round);
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw new Error('forced rename failure');
    return rename(from, to);
  });
  assert.throws(
    () =>
      mgr.record({
        job_id: view.job_id,
        entries: [{ id: 'f1', verdict: 'confirmed' }],
        reflection: { delta: 'Must not survive a failure.' },
      }),
    (e) => e.code === 'record_not_saved',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(mgr.jobs.get(view.job_id).record?.entries.some((e) => e.id === 'f1') ?? false, false);
  assert.equal(mgr.jobs.get(view.job_id).reflection, null);
  assert.deepEqual(
    mgr.view(view.job_id).record?.entries.map((e) => e.id),
    ['u1'],
  );
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
});

test('a writer killed while holding the record lock leaves saved checks intact and the next writer can recover', async (t) => {
  const { mgr, view } = await completed();
  mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'confirmed' }], reflection: { delta: 'Already saved.' } });
  const store = await import('../src/store.mjs');
  const file = store.roundPath(view.chain_id, view.round);
  const held = path.join(home, `held-${view.job_id}`);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs';
    const { JobManager } = await import(${JSON.stringify(new URL('../src/jobs.mjs', import.meta.url).href)});
    const store = await import(${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)});
    const mgr = new JobManager();
    mgr.jobs.set(${JSON.stringify(view.job_id)}, store.loadRound(${JSON.stringify(view.job_id)}));
    const read = fs.readFileSync;
    fs.readFileSync = function(p, ...args) {
      const value = read.call(this, p, ...args);
      if (String(p) === ${JSON.stringify(file)}) {
        fs.writeFileSync(${JSON.stringify(held)}, '');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return value;
    };
    mgr.record({ job_id: ${JSON.stringify(view.job_id)}, entries: [{ id: 'c1', verdict: 'confirmed' }] });
  `,
    ],
    { env: process.env },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await waitFor(() => fs.existsSync(held), { timeoutMs: 5000 });
  assert.ok(fs.existsSync(`${file}.lock`), 'the read and merge happen inside the record lock');
  child.kill('SIGKILL');
  await exited;
  const started = Date.now();
  mgr.record({ job_id: view.job_id, entries: [{ id: 'u1', verdict: 'unverifiable' }] });
  assert.ok(Date.now() - started < 5000, 'dead owners do not prevent the next save');
  const saved = roundFile(view);
  assert.deepEqual(
    saved.record.entries.map((e) => [e.id, e.verdict]),
    [
      ['f1', 'confirmed'],
      ['u1', 'unverifiable'],
    ],
  );
  assert.equal(saved.reflection.delta, 'Already saved.');
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a disk read failure cannot overwrite another session's saved checks with cached values", async (t) => {
  const { mgr, view } = await completed();
  new JobManager().record({
    job_id: view.job_id,
    entries: [{ id: 'u1', verdict: 'unverifiable' }],
    reflection: { delta: 'Saved elsewhere.' },
  });
  const store = await import('../src/store.mjs');
  const file = store.roundPath(view.chain_id, view.round);
  const bytes = fs.readFileSync(file, 'utf8');
  const read = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (p, ...args) => {
    if (String(p) === file) throw Object.assign(new Error('forced read failure'), { code: 'EACCES' });
    return read(p, ...args);
  });
  assert.throws(
    () => mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'confirmed' }] }),
    (e) => e.code === 'record_not_saved',
  );
  assert.equal(mgr.jobs.get(view.job_id).record, null);
  mock.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(
    mgr.view(view.job_id).record.entries.map((e) => e.id),
    ['u1'],
  );
  assert.equal(mgr.view(view.job_id).reflection.delta, 'Saved elsewhere.');
});

test('a replaced lock during owner registration never admits two writers', async (t) => {
  const { mgr, view } = await completed();
  const store = await import('../src/store.mjs');
  const file = store.roundPath(view.chain_id, view.round);
  const lock = `${file}.lock`;
  const mkdir = fs.mkdirSync;
  const bytes = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'mkdirSync', (p, ...args) => {
    const value = mkdir(p, ...args);
    if (String(p) === lock) {
      // A stale empty directory was reclaimed before the delayed owner got
      // to register itself; the new owner already holds this replacement.
      fs.rmdirSync(lock);
      mkdir(lock);
      mkdir(path.join(lock, `owner-${process.ppid}`));
    }
    return value;
  });
  try {
    assert.throws(
      () => mgr.record({ job_id: view.job_id, entries: [{ id: 'f1', verdict: 'confirmed' }] }),
      (e) => e.code === 'record_not_saved',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(lock), [`owner-${process.ppid}`], 'the replacement owner keeps its lock');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('prior-round reflections carry bounded lead text and round-qualified related IDs', async () => {
  const { renderBrief } = await import('../src/brief.mjs');
  const brief = renderBrief(reviewRequest(), {
    round: 2,
    priorRounds: [
      {
        round: 1,
        mode: 'review',
        question: 'Earlier question.',
        summary: 'Earlier answer.',
        reflection: {
          delta: 'x'.repeat(400) + 'OMITTED_REFLECTION_TAIL',
          related_item_ids: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
        },
      },
    ],
  });
  assert.ok(brief.includes('x'.repeat(400) + '...'));
  assert.doesNotMatch(brief, /OMITTED_REFLECTION_TAIL/);
  assert.match(brief, /r1\.f1, r1\.f2, r1\.f3, r1\.f4, r1\.f5/);
  assert.doesNotMatch(brief, /r1\.f6/);
  assert.match(brief, /1 more/);
});
