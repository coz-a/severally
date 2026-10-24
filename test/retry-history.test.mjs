import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { RequestError, requestSchema } = await import('../src/schema.mjs');
const store = await import('../src/store.mjs');
const finish = async (mgr, started) => {
  await mgr.jobs.get(started.job_id).promise;
  return mgr.view(started.job_id, { detail: 'full' });
};
const fails = (fn, code) => assert.throws(fn, (e) => e instanceof RequestError && e.code === code);

test('retry_of replays only a failed member after restart, preserving old records and changed/deleted material', async () => {
  const files = path.join(home, 'materials');
  fs.mkdirSync(files);
  const changed = path.join(files, 'changed.mjs');
  const deleted = path.join(files, 'deleted.mjs');
  fs.writeFileSync(changed, 'before');
  fs.writeFileSync(deleted, 'remove me');
  const mgr = new JobManager();
  process.env.STUB_BEHAVIOR = 'auth_mixed';
  const group = mgr.start(
    reviewRequest({
      target: undefined,
      targets: ['codex', 'claude-code'],
      network: 'off',
      caller: 'codex',
      context: { proposal: 'Saved proposal', facts: ['Saved fact'], expose_paths: [changed, deleted] },
    }),
  );
  const [failed, success] = await Promise.all(group.jobs.map((job) => finish(mgr, job)));
  assert.equal(failed.status, 'failed');
  assert.equal(success.status, 'completed');
  assert.equal(failed.retries.length, 0, 'auth is never auto-looped');
  assert.match(failed.next_step, new RegExp(`retry_of.*${failed.job_id}`));
  const oldFailure = fs.readFileSync(store.roundPath(failed.chain_id, failed.round), 'utf8');
  const oldSuccess = fs.readFileSync(store.roundPath(success.chain_id, success.round), 'utf8');
  fs.writeFileSync(changed, 'after');
  fs.rmSync(deleted);
  process.env.STUB_BEHAVIOR = 'ok';
  const restarted = new JobManager();
  const started = restarted.start(requestSchema.parse({ retry_of: failed.job_id }));
  assert.equal(started.retry_of, failed.job_id);
  assert.notEqual(started.chain_id, failed.chain_id);
  assert.equal(started.round, 1);
  assert.equal(restarted.jobs.size, 1, 'only failed consultant is launched');
  assert.equal(started.exposed_from_parent.entries[0].changed, true);
  assert.ok(started.exposed_from_parent.left_out.some((x) => x.reason === 'gone'));
  const retried = await finish(restarted, started);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.question, failed.question);
  assert.equal(retried.retry_of, failed.job_id);
  assert.equal(retried.followup_to, null);
  assert.equal(retried.network, 'off');
  assert.equal(retried.caller, 'codex');
  assert.equal(retried.model, failed.model);
  assert.deepEqual(retried.brief.facts, failed.brief.facts);
  const exposure = restarted.view(retried.job_id).brief.exposed;
  assert.equal(exposure.changed, 1);
  assert.match(exposure.action_needed, /unverified/);
  assert.match(exposure.action_needed, /protected/i);
  assert.equal(fs.readFileSync(store.roundPath(failed.chain_id, failed.round), 'utf8'), oldFailure);
  assert.equal(fs.readFileSync(store.roundPath(success.chain_id, success.round), 'utf8'), oldSuccess);
  assert.equal(new JobManager().view(retried.job_id).retry_of, failed.job_id);
});

test('retry_of refuses success, cancellation, groups, missing IDs and overrides before launch', async () => {
  const mgr = new JobManager();
  process.env.STUB_BEHAVIOR = 'ok';
  const success = await finish(mgr, mgr.start(reviewRequest()));
  fails(() => mgr.start({ retry_of: success.job_id }), 'retry_not_failed');
  fails(() => mgr.start({ retry_of: 'group_1234' }), 'invalid_request');
  fails(() => mgr.start({ retry_of: 'job_missing' }), 'unknown_job');
  process.env.STUB_BEHAVIOR = 'auth';
  const failed = await finish(mgr, mgr.start(reviewRequest()));
  for (const extra of [
    { question: failed.question },
    { target: failed.target },
    { network: 'on' },
    { followup_to: success.job_id },
    { context: { facts: ['override'] } },
  ]) {
    fails(() => mgr.start({ retry_of: failed.job_id, ...extra }), 'invalid_request');
  }
  const cancelled = { ...store.loadRound(failed.job_id), status: 'cancelled' };
  store.persistRound(cancelled, { appendIndex: false });
  fails(() => new JobManager().start({ retry_of: failed.job_id }), 'retry_not_failed');
  assert.equal(mgr.jobs.size, 2);
});

test('retry refuses changed consultant identity and missing saved briefs', async () => {
  process.env.STUB_BEHAVIOR = 'auth';
  const mgr = new JobManager();
  const failed = await finish(mgr, mgr.start(reviewRequest()));
  const saved = store.loadRound(failed.job_id);
  store.persistRound({ ...saved, model: 'different-model' }, { appendIndex: false });
  fails(() => new JobManager().start({ retry_of: failed.job_id }), 'retry_target_mismatch');
  store.persistRound({ ...saved, brief: null }, { appendIndex: false });
  fails(() => new JobManager().start({ retry_of: failed.job_id }), 'retry_inputs_missing');
});

test('retry of failed follow-up keeps prior answer context in its new chain and subsequent follow-ups', async () => {
  const mgr = new JobManager();
  process.env.STUB_BEHAVIOR = 'ok';
  const first = await finish(mgr, mgr.start(reviewRequest({ question: 'Original context question' })));
  process.env.STUB_BEHAVIOR = 'auth';
  const failed = await finish(mgr, mgr.start({ followup_to: first.job_id, question: 'Failed follow-up question' }));
  process.env.STUB_BEHAVIOR = 'ok';
  const briefPath = path.join(home, 'retry-brief.txt');
  process.env.STUB_BRIEF_OUT = briefPath;
  try {
    const restarted = new JobManager();
    const retried = await finish(restarted, restarted.start({ retry_of: failed.job_id }));
    assert.match(fs.readFileSync(briefPath, 'utf8'), /Original context question/);
    assert.match(fs.readFileSync(briefPath, 'utf8'), new RegExp(`${first.job_id}\\.f1`));
    assert.equal(retried.followup_to, null);
    assert.deepEqual(retried.retry_context, [first.job_id]);
    await finish(restarted, restarted.start({ followup_to: retried.job_id, question: 'Continue the retry' }));
    const laterBrief = fs.readFileSync(briefPath, 'utf8');
    assert.match(laterBrief, /Original context question/);
    assert.match(laterBrief, new RegExp(`${first.job_id}\\.f1`));
    assert.match(laterBrief, /- r1\.f1:/, 'new chain points retain their local round IDs');
  } finally {
    delete process.env.STUB_BRIEF_OUT;
  }
});

test('list filters saved history before limiting and returns continuation metadata after restart', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = await finish(mgr, mgr.start(reviewRequest({ question: 'Unique LIST needle' })));
  const latest = await finish(mgr, mgr.start({ followup_to: first.job_id, question: 'Second matching NEEDLE' }));
  await finish(mgr, mgr.start(reviewRequest({ target: 'claude-code', question: 'Unrelated question' })));
  process.env.STUB_BEHAVIOR = 'auth';
  const failed = await finish(mgr, mgr.start({ followup_to: latest.job_id, question: 'Third matching needle' }));
  const restarted = new JobManager();
  const rows = restarted.list({ target: 'openai', question: 'NeEdLe', chain_id: first.chain_id, limit: 2 });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.target === 'codex' && x.chain_id === first.chain_id));
  assert.ok(rows.every((x) => x.latest_completed_job_id === latest.job_id && x.rounds_remaining === 2));
  assert.ok(rows.some((x) => x.job_id === failed.job_id));
  assert.deepEqual(restarted.list({ question: 'does not exist' }), []);
  for (const opts of [{ target: 'does not exist' }, { question: 3 }, { chain_id: '../escape' }, { limit: 0 }]) {
    assert.throws(() => restarted.list(opts), RequestError);
  }
});

test('list finds an exact historical target after it is removed from the current configuration', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest({ question: 'Historical removed consultant' })));
  const saved = store.loadRound(view.job_id);
  store.persistRound({ ...saved, target: 'retired-reviewer' }, { appendIndex: false });
  const restarted = new JobManager();
  assert.equal(restarted.list({ chain_id: view.chain_id })[0].target, 'retired-reviewer');
  const listed = restarted.list({ target: 'retired-reviewer', question: 'Historical removed', limit: 1 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].job_id, view.job_id);
  assert.equal(listed[0].latest_completed_job_id, view.job_id);
  fails(() => restarted.list({ target: 'never-a-consultant' }), 'unknown_target');
});

test('retry context refreshes verdicts recorded by another manager before continuing', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const owner = new JobManager();
  const first = await finish(owner, owner.start(reviewRequest({ question: 'Cross-session retry context' })));
  process.env.STUB_BEHAVIOR = 'auth';
  const failed = await finish(owner, owner.start({ followup_to: first.job_id, question: 'Failed later question' }));
  process.env.STUB_BEHAVIOR = 'ok';
  const retried = await finish(owner, owner.start({ retry_of: failed.job_id }));
  new JobManager().record({
    job_id: first.job_id,
    entries: [{ id: 'f1', verdict: 'confirmed', effect: 'external-verified-effect', note: 'private local evidence' }],
  });
  const briefPath = path.join(home, 'external-record-retry-brief.txt');
  process.env.STUB_BRIEF_OUT = briefPath;
  try {
    await finish(owner, owner.start({ followup_to: retried.job_id, question: 'Continue after external check' }));
    const brief = fs.readFileSync(briefPath, 'utf8');
    assert.match(brief, new RegExp(`${first.job_id}\\.f1`));
    assert.match(brief, /external-verified-effect/);
    assert.doesNotMatch(brief, /private local evidence/, 'local evidence notes stay outside the consultant brief');
  } finally {
    delete process.env.STUB_BRIEF_OUT;
  }
});
