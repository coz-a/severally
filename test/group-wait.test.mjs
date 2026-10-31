import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const gate = path.join(home, 'release-claude');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ clis: { 'claude-code': { env: { STUB_GATE_FILE: gate } } } }));
const { JobManager } = await import('../src/jobs.mjs');
// Include the managed Windows launcher's startup, while still failing if the
// reader waits out the entire budget instead of returning a new completion.
const firstWaitMs = process.platform === 'win32' ? 10000 : 2500;
const firstReturnLimitMs = firstWaitMs - 700;

const start = (t) => {
  fs.rmSync(gate, { force: true });
  const owner = new JobManager();
  const started = owner.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  t.after(async () => {
    fs.writeFileSync(gate, 'release');
    owner.cancelGroup(started.group_id);
    await Promise.all(started.jobs.map(({ job_id }) => owner.jobs.get(job_id).promise));
  });
  return { owner, ...started };
};

for (const elsewhere of [false, true]) {
  const route = elsewhere ? 'another manager' : 'the owner';
  test(`${route} returns the first answer and waits for a new completion on the next call`, async (t) => {
    process.env.STUB_BEHAVIOR = 'ok';
    const { owner, group_id } = start(t);
    const reader = elsewhere ? new JobManager() : owner;
    const startedAt = Date.now();
    const first = await reader.waitGroup(group_id, firstWaitMs);
    assert.ok(Date.now() - startedAt < firstReturnLimitMs, 'return a newly finished member before the wait budget expires');
    assert.equal(first.status, 'running');
    assert.equal(first.member_counts.completed, 1, 'the fast answer must be returned while the second is gated');
    assert.equal(first.comparison.by_target.find((m) => m.target === 'codex').stance, 'proceed');

    const before = Date.now();
    const unchanged = await reader.waitGroup(group_id, 150);
    assert.equal(unchanged.member_counts.completed, 1);
    assert.ok(Date.now() - before >= 100, 'an already returned answer must not create an immediate poll loop');

    const second = reader.waitGroup(group_id, 2500);
    fs.writeFileSync(gate, 'release');
    const final = await second;
    assert.equal(final.status, 'done');
    assert.equal(final.member_counts.completed, 2);
    assert.deepEqual(
      final.comparison.by_target.map((m) => m.stance),
      ['proceed', 'do_not_proceed'],
    );
    assert.equal((await reader.waitGroup(group_id, 2500)).status, 'done');
  });

  test(`${route} returns a failed member without waiting for a silent member`, async (t) => {
    process.env.STUB_BEHAVIOR = 'auth';
    const { owner, group_id } = start(t);
    const reader = elsewhere ? new JobManager() : owner;
    const startedAt = Date.now();
    const first = await reader.waitGroup(group_id, firstWaitMs);
    assert.ok(Date.now() - startedAt < firstReturnLimitMs, 'failure is a new terminal event too');
    assert.equal(first.status, 'running');
    assert.equal(first.member_counts.failed, 1);
    assert.equal(first.members.find((m) => m.target === 'codex').failure.kind, 'auth');
    owner.cancelGroup(group_id);
    const final = await reader.waitGroup(group_id, 2500);
    assert.equal(final.status, 'done');
    assert.equal(final.member_counts.failed, 1);
    assert.equal(final.member_counts.cancelled, 1);
  });

  test(`${route} stops a group wait when the request is aborted`, async (t) => {
    process.env.STUB_BEHAVIOR = 'ok';
    const { owner, group_id, jobs } = start(t);
    const reader = elsewhere ? new JobManager() : owner;
    await owner.jobs.get(jobs[0].job_id).promise;
    await reader.waitGroup(group_id, 0);
    const controller = new AbortController();
    const before = Date.now();
    const waiting = reader.waitGroup(group_id, 5000, undefined, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const view = await waiting;
    assert.equal(view.status, 'running');
    assert.ok(Date.now() - before < 1000);
    assert.equal(owner.jobs.get(jobs[1].job_id).cancelRequested, false, 'aborting a wait does not cancel advice');
  });
}

test('a separate server process returns new completions and does not repeat an already delivered answer', async (t) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { owner, group_id } = start(t);
  const source = `
    const { JobManager } = await import(${JSON.stringify(new URL('../src/jobs.mjs', import.meta.url).href)});
    const manager = new JobManager();
    process.on('message', async ({groupId, waitMs}) => process.send(await manager.waitGroup(groupId, waitMs)));
    process.on('disconnect', () => process.exit(0));
    process.send('ready');
  `;
  const reader = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  t.after(() => reader.disconnect());
  await new Promise((resolve) => reader.once('message', resolve));
  const get = (waitMs) =>
    new Promise((resolve) => {
      reader.once('message', resolve);
      reader.send({ groupId: group_id, waitMs });
    });
  const before = Date.now();
  const first = await get(firstWaitMs);
  assert.ok(Date.now() - before < firstReturnLimitMs);
  assert.equal(first.member_counts.completed, 1);
  assert.equal(first.status, 'running');
  const waitingAt = Date.now();
  const unchanged = await get(150);
  assert.equal(unchanged.member_counts.completed, 1);
  assert.ok(Date.now() - waitingAt >= 100);
  owner.cancelGroup(group_id);
  const cancelled = await get(2500);
  assert.equal(cancelled.status, 'done');
  assert.equal(cancelled.member_counts.completed, 1);
  assert.equal(cancelled.member_counts.cancelled, 1);
});
