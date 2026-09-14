import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

// The retention cap is frozen when policy.mjs first loads, and a query-string
// re-import of jobs.mjs reuses that same policy module -- so a cap the eviction
// test below can actually reach has to be in place before the first import.
// It goes through sandboxEnv's overrides because sandboxEnv clears the whole
// SEVERALLY_ namespace first (see the comment there).
const RETAINED = 20;
const home = sandboxEnv({ SEVERALLY_MAX_JOBS_RETAINED: String(RETAINED) });
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
  // Consultants that share a finding can still land on opposite bottom lines,
  // and that is the divergence a lead is most likely to miss. The stance is
  // the consultant's own declaration, placed beside the others unjudged.
  for (const t of view.comparison.by_target) assert.equal(t.stance, 'proceed');
  assert.match(view.comparison.note, /stance/i);
  assert.match(view.comparison.note, /consultant's own|declared by the consultant/i);
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

test('a group prints the shared brief once, not once per consultant', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'antigravity'] }));

  // While it runs, the lead is polling for an answer it does not have yet, and
  // the brief is the biggest thing in the payload. Echoing it back on every
  // poll spends the lead's context on what it wrote itself a minute ago.
  const running = mgr.groupView(started.group_id);
  assert.equal(running.status, 'running');
  for (const m of running.members) {
    assert.equal(m.brief, undefined, 'a member never carries its own copy of the brief');
    assert.match(m.brief_note, /omitted while the consultation is running/);
  }

  const view = await finishGroup(mgr, started.group_id);
  assert.equal(view.members.length, 2);
  for (const m of view.members) assert.equal(m.brief, undefined);
  // Nothing is lost: every member was sent the byte-identical brief, so one
  // copy at the group says everything three copies said.
  assert.ok(view.brief, 'the finished group still carries the brief it sent');
  assert.equal(view.brief.objective, reviewRequest().objective);
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
  process.env.SEVERALLY_TIMEOUT_MS = '1200';
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
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
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
  process.env.SEVERALLY_TIMEOUT_MS = '1500';
  const { JobManager: M } = await import(`../src/jobs.mjs?cancelgroup=${Date.now()}`);
  const mgr = new M();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  const cancelled = mgr.cancelGroup(started.group_id);
  assert.equal(cancelled.members.every((m) => m.status === 'cancelling' || m.status === 'cancelled'), true);
  assert.equal(cancelled.status, 'cancelling');
  assert.match(cancelled.cancel_effect, /every consultant process group/);
  assert.deepEqual(
    cancelled.comparison.by_target.map((t) => t.status),
    cancelled.members.map((m) => m.status),
    'one payload must not report two different statuses for the same job',
  );
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  const after = mgr.groupView(started.group_id);
  assert.equal(after.members.every((m) => m.status === 'cancelled'), true);
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
});

test('cancelling a group that already finished does not claim to have signalled anything', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await finishGroup(mgr, started.group_id);

  const cancelled = mgr.cancelGroup(started.group_id);
  assert.match(cancelled.cancel_effect, /nothing to signal/);
  assert.equal(cancelled.status, 'done');
  assert.deepEqual(
    cancelled.members.map((m) => m.cancel_effect),
    ['job was already completed', 'job was already completed'],
  );
});

// "Nothing live" used to mean "compare the divergences", which is nonsense --
// and dangerous -- when there is nothing to compare.
test('a fan-out in which every member failed says no advice was obtained', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  const view = await finishGroup(mgr, started.group_id);
  process.env.STUB_BEHAVIOR = 'ok';

  assert.equal(view.status, 'done');
  assert.equal(view.members.every((m) => m.status === 'failed'), true);
  assert.deepEqual(view.members.map((m) => m.failure.kind), ['usage_limit', 'usage_limit']);
  assert.match(view.next_step, /no advice was obtained/);
  assert.doesNotMatch(view.next_step, /diverge/);
  assert.equal(view.comparison.by_target.every((t) => t.summary === null), true);
});

test('a fan-out where only one member answered is still told to compare', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await finishGroup(mgr, started.group_id);
  // STUB_BEHAVIOR is process-wide, so the mixed outcome -- one consultant
  // answered, the other failed -- has to be staged on the finished group.
  const failed = mgr.jobs.get(started.jobs[1].job_id);
  failed.status = 'failed';
  failed.result = null;
  failed.quality = null;
  failed.failure = {
    kind: 'usage_limit', message: 'quota', detail: null, retriable: false, delivered_advice: false,
  };

  const view = mgr.groupView(started.group_id);
  assert.equal(view.status, 'done');
  assert.match(view.next_step, /diverge/, 'one real answer is still worth comparing against the failure');
});

test('a group stops claiming answers once its members age out of history', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const group = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await Promise.all(group.jobs.map((j) => mgr.jobs.get(j.job_id).promise));

  // Push the group's members out of the retention window, one job at a time.
  const fill = async (n) => {
    for (let i = 0; i < n; i += 1) {
      const s = mgr.start(reviewRequest());
      await mgr.jobs.get(s.job_id).promise;
    }
  };

  await fill(RETAINED - 1); // one job past the cap: the group's first member is evicted
  const partial = mgr.groupView(group.group_id);
  assert.equal(partial.members_expected, 2);
  assert.equal(partial.members_available, 1);
  assert.equal(partial.comparison.by_target.length, 1);
  assert.match(partial.incomplete_note, /aged out|partial/);

  await fill(1); // the last member goes too, and the group goes with it
  assert.equal(mgr.groups.has(group.group_id), false);
  assert.equal(mgr.groupView(group.group_id), null);
});

test('the side-by-side shows what would change each judgement, and how heavy the findings are', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['gpt', 'gemini'] }));
  const view = await finishGroup(mgr, started.group_id);

  const codex = view.comparison.by_target.find((t) => t.target === 'codex');
  assert.deepEqual(codex.decision_changers, [{ condition: 'QPS below 5', changes_to: 'No cap needed' }]);
  assert.deepEqual(codex.severity_counts, { high: 1 });

  // Two consultants can name the same condition and still be worth reading
  // side by side; the server places them, it does not match them up.
  const agy = view.comparison.by_target.find((t) => t.target === 'antigravity');
  assert.deepEqual(agy.decision_changers, [{ condition: 'QPS below 5', changes_to: 'No cap needed' }]);
  assert.deepEqual(agy.severity_counts, { high: 1 });
});

test('a consultant that never answered contributes no weight to the side-by-side', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['gpt', 'gemini'] }));
  const view = await finishGroup(mgr, started.group_id);
  for (const t of view.comparison.by_target) {
    assert.deepEqual(t.decision_changers, []);
    assert.deepEqual(t.severity_counts, {});
  }
});
