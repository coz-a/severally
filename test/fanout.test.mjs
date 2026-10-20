import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest, debateRequest } from './helpers.mjs';

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
  for (const m of running.members) assert.equal(m.brief, undefined, 'a member never carries its own copy of the brief');
  assert.equal(running.brief, null);
  for (const m of mgr.groupView(started.group_id, { detail: 'full' }).members) {
    assert.match(m.brief_note, /omitted while the consultation is running/);
  }

  const view = await finishGroup(mgr, started.group_id);
  assert.equal(view.members.length, 2);
  for (const m of view.members) assert.equal(m.brief, undefined);
  // The lead wrote the brief itself, so a finished group names it rather than
  // repeating it: one copy, at the group, checkable against the round file.
  const roundFile = JSON.parse(fs.readFileSync(path.join(home, view.brief.history_file), 'utf8'));
  assert.equal(view.brief.sha256, crypto.createHash('sha256').update(JSON.stringify(roundFile.brief)).digest('hex'));
  assert.equal(view.brief.chars, JSON.stringify(roundFile.brief).length);
  assert.match(view.brief.full_with, /detail: "full"/);
  // detail: "full" is the old shape: the brief once, at the group.
  const full = mgr.groupView(started.group_id, { detail: 'full' });
  assert.equal(full.brief.objective, reviewRequest().objective);
  for (const m of full.members) assert.equal(m.brief, undefined);
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
  const started = [1, 2, 3, 4, 5, 6].map(() => mgr.start(reviewRequest()));
  // The default cap is 9; an "everyone" fan-out adds four members, so refusal
  // takes a group that would push the total to ten.
  assert.throws(
    () => mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code', 'antigravity', 'opencode'] })),
    (e) => e.code === 'concurrency_limit',
  );
  assert.equal(mgr.running.length, 6, 'a refused group must not leave half its jobs running');
  mgr.shutdown();
  await Promise.all(started.map((s) => mgr.jobs.get(s.job_id).promise));
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
});

test('an everyone fan-out fits the default concurrency cap exactly', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { JobManager: M } = await import(`../src/jobs.mjs?everyone=${Date.now()}`);
  const mgr = new M();
  const started = mgr.start(reviewRequest({
    target: undefined,
    targets: ['codex', 'claude-code', 'antigravity', 'opencode'],
  }));
  assert.deepEqual(started.jobs.map((j) => j.target), ['codex', 'claude-code', 'antigravity', 'opencode']);
  const view = await finishGroup(mgr, started.group_id);
  assert.equal(view.members.length, 4);
  assert.equal(view.status, 'done');
});

test('a follow-up to one job cannot fan out', async () => {
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
    (e) => e.code === 'followup_fanout_not_allowed' && /group_id/.test(e.message),
  );
});

test('a follow-up to a group goes to every member, each on its own chain with its own history', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await finishGroup(mgr, first.group_id);
  mgr.record({ job_id: first.jobs[0].job_id, entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Codex was right.' }] });

  const briefDir = fs.mkdtempSync(path.join(home, 'briefs-'));
  process.env.STUB_BRIEF_DIR = briefDir;
  const next = mgr.start(reviewRequest({ target: undefined, followup_to: first.group_id }));
  await finishGroup(mgr, next.group_id);
  delete process.env.STUB_BRIEF_DIR;

  assert.equal(next.round, 2);
  assert.equal(next.followup_to_group, first.group_id);
  assert.deepEqual(next.skipped, []);
  assert.deepEqual(next.jobs.map((j) => j.target), ['codex', 'claude-code']);
  assert.deepEqual(next.jobs.map((j) => j.chain_id), first.jobs.map((j) => j.chain_id));
  assert.deepEqual(next.jobs.map((j) => mgr.view(j.job_id).followup_to), first.jobs.map((j) => j.job_id));
  // The new question is the same for both; the earlier round each one sees is its own.
  const codexBrief = fs.readFileSync(path.join(briefDir, 'codex.txt'), 'utf8');
  const claudeBrief = fs.readFileSync(path.join(briefDir, 'claude-code.txt'), 'utf8');
  assert.match(codexBrief, /lead's verdict: confirmed \(Codex was right\.\)/);
  assert.doesNotMatch(claudeBrief, /Codex was right/);
  const shared = (b) => b.slice(0, b.indexOf('## Earlier rounds'));
  assert.equal(shared(codexBrief), shared(claudeBrief));
});

test('a follow-up to a group skips members that cannot take one, and names why', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await finishGroup(mgr, first.group_id);
  // One member followed up on its own: the group follow-up continues after that round.
  const solo = mgr.start(reviewRequest({ target: 'codex', followup_to: first.jobs[0].job_id }));
  await mgr.jobs.get(solo.job_id).promise;
  // STUB_BEHAVIOR is process-wide, so a failed member is staged on the finished group.
  const failed = mgr.jobs.get(first.jobs[1].job_id);
  failed.status = 'failed';
  failed.result = null;

  const next = mgr.start(reviewRequest({ target: undefined, followup_to: first.group_id }));
  await finishGroup(mgr, next.group_id);
  assert.equal(next.target, 'codex', 'one member left: a group of one');
  assert.equal(next.round, 3);
  assert.equal(mgr.view(next.job_id).followup_to, solo.job_id);
  assert.deepEqual(next.skipped.map((x) => [x.target, x.reason]), [['claude-code', 'failed, so there is no answer to follow up']]);
});

test('a follow-up to a group is refused when no member can take one, or when it names targets', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await finishGroup(mgr, first.group_id);
  assert.throws(
    () => mgr.start(reviewRequest({ target: 'codex', followup_to: first.group_id })),
    (e) => e.code === 'followup_group_targets',
  );
  // A member whose consultant is no longer configured is skipped, not re-resolved.
  mgr.jobs.get(first.jobs[1].job_id).target = 'renamed-away';
  const next = mgr.start(reviewRequest({ target: undefined, followup_to: first.group_id }));
  assert.deepEqual(next.skipped.map((x) => x.target), ['renamed-away']);
  assert.match(next.skipped[0].reason, /no longer configured/);
  await mgr.jobs.get(next.job_id).promise;
  for (const jid of [...first.jobs.map((j) => j.job_id), next.job_id]) mgr.jobs.get(jid).status = 'cancelled';
  assert.throws(
    () => mgr.start(reviewRequest({ target: undefined, followup_to: first.group_id })),
    (e) => e.code === 'followup_nothing_to_continue' && /codex/.test(e.message) && /renamed-away/.test(e.message),
  );
  assert.throws(
    () => mgr.start(reviewRequest({ target: undefined, followup_to: 'group_000000000000' })),
    (e) => e.code === 'unknown_group',
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
  // Nobody has finished yet, so there is no side-by-side to carry.
  assert.equal(cancelled.comparison, null);
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  const after = mgr.groupView(started.group_id);
  assert.equal(after.members.every((m) => m.status === 'cancelled'), true);
  // One payload must not report two different statuses for the same job: a
  // member's status is said once, in members.
  for (const t of after.comparison.by_target) assert.equal('status' in t, false);
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

test('a group whose members age out of memory is read back from history', async () => {
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
  assert.equal(partial.members_available, 2, 'the evicted member comes back from its round file');
  assert.equal(partial.comparison.by_target.length, 2);

  await fill(1); // the last member goes too, and the group leaves memory
  assert.equal(mgr.groups.has(group.group_id), false);
  const fromHistory = mgr.groupView(group.group_id);
  assert.equal(fromHistory.members_available, 2);
  assert.equal(fromHistory.status, 'done');
  assert.match(mgr.cancelGroup(group.group_id).cancel_effect, /nothing to signal/);
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

test('a follow-up to a group needs only followup_to and the question, and every member gets the same brief', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = mgr.start(debateRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await finishGroup(mgr, first.group_id);
  const briefDir = fs.mkdtempSync(path.join(home, 'briefs-'));
  process.env.STUB_BRIEF_DIR = briefDir;
  const next = mgr.start({ followup_to: first.group_id, question: 'Which counterpoint is strongest?' });
  await finishGroup(mgr, next.group_id);
  delete process.env.STUB_BRIEF_DIR;
  assert.equal(next.mode, 'debate');
  const shared = (b) => b.slice(0, b.indexOf('## Earlier rounds'));
  const codexBrief = shared(fs.readFileSync(path.join(briefDir, 'codex.txt'), 'utf8'));
  assert.equal(codexBrief, shared(fs.readFileSync(path.join(briefDir, 'claude-code.txt'), 'utf8')));
  assert.match(codexBrief, /Write-behind with a durable log/);
  assert.match(codexBrief, /Write-through, because/);
});
