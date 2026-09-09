import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');

const finishGroup = async (mgr, groupId) => {
  const g = mgr.groups.get(groupId);
  await Promise.all(g.job_ids.map((jid) => mgr.jobs.get(jid).promise));
  return mgr.groupView(groupId);
};

test('targets fans out to one job per consultant and returns a group', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['gpt', 'gemini'] }));
  assert.ok(started.group_id);
  assert.deepEqual(started.jobs.map((j) => j.target), ['codex', 'antigravity']);
  assert.equal(started.jobs.length, 2);

  const view = await finishGroup(mgr, started.group_id);
  assert.equal(view.status, 'done');
  assert.equal(view.members.length, 2);
  assert.deepEqual(view.comparison.by_target.map((t) => t.target), ['codex', 'antigravity']);
  assert.match(view.comparison.note, /not evidence of agreement|does not judge/i);
  assert.match(view.next_step, /diverge/i);
});

test('every consultant in a group receives the identical brief', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const briefDir = fs.mkdtempSync(path.join(home, 'briefs-'));
  process.env.STUB_BRIEF_DIR = briefDir;
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await finishGroup(mgr, started.group_id);
  delete process.env.STUB_BRIEF_DIR;

  const codexBrief = fs.readFileSync(path.join(briefDir, 'codex.txt'), 'utf8');
  const claudeBrief = fs.readFileSync(path.join(briefDir, 'claude-code.txt'), 'utf8');
  assert.equal(codexBrief, claudeBrief, 'a fan-out is only comparable if the brief is byte-identical');
});

test('a single target keeps the old response shape and gains a group_id', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  assert.equal(started.target, 'codex');
  assert.ok(started.job_id);
  assert.ok(started.group_id);
  assert.equal(started.jobs, undefined);
  await mgr.jobs.get(started.job_id).promise;
});

test('naming the same consultant twice is refused', () => {
  const mgr = new JobManager();
  assert.throws(
    () => mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'gpt'] })),
    (e) => e.code === 'duplicate_targets',
  );
});

test('target and targets together, or neither, is refused', () => {
  const mgr = new JobManager();
  assert.throws(() => mgr.start(reviewRequest({ targets: ['codex'] })), (e) => e.code === 'invalid_request');
  assert.throws(() => mgr.start(reviewRequest({ target: undefined })), (e) => e.code === 'target_required');
});

test('a group that would exceed the concurrency cap is refused before anything starts', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.PEER_CONSULT_TIMEOUT_MS = '1200';
  const { JobManager: M } = await import(`../src/jobs.mjs?fanout=${Date.now()}`);
  const mgr = new M();
  const a = mgr.start(reviewRequest());
  assert.throws(
    () => mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code', 'antigravity'] })),
    (e) => e.code === 'concurrency_limit',
  );
  assert.equal(mgr.running.length, 1, 'a refused group must not leave half its jobs running');
  mgr.shutdown();
  await mgr.jobs.get(a.job_id).promise;
  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
});

test('a follow-up cannot fan out', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = mgr.start(reviewRequest());
  await mgr.jobs.get(first.job_id).promise;
  assert.throws(
    () => mgr.start(reviewRequest({
      target: undefined,
      targets: ['codex', 'claude-code'],
      followup_to: first.job_id,
    })),
    (e) => e.code === 'followup_fanout_not_allowed',
  );
});

test('cancelling a group stops every member', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.PEER_CONSULT_TIMEOUT_MS = '1500';
  const { JobManager: M } = await import(`../src/jobs.mjs?cancelgroup=${Date.now()}`);
  const mgr = new M();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  const cancelled = mgr.cancelGroup(started.group_id);
  assert.equal(cancelled.members.every((m) => m.status === 'cancelling' || m.status === 'cancelled'), true);
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  const after = mgr.groupView(started.group_id);
  assert.equal(after.members.every((m) => m.status === 'cancelled'), true);
  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
});
