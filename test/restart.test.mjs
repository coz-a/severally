import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxEnv, reviewRequest, waitFor } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager, pointsOf } = await import('../src/jobs.mjs');
const store = await import('../src/store.mjs');

const indexLines = (jobId) =>
  fs
    .readFileSync(path.join(home, 'history', 'index.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes(jobId)).length;
// A pid that belonged to a process which has already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const [method, code, stage] of [
  ['writeFileSync', 'ENOSPC', 'round'],
  ['renameSync', 'EACCES', 'round'],
  ['appendFileSync', 'ENOSPC', 'index'],
]) {
  test(`a ${stage} ${method} failure keeps completed advice and recovers without another consultation`, async (t) => {
    process.env.STUB_BEHAVIOR = 'ok';
    const original = fs[method];
    let blocked = true;
    t.mock.method(fs, method, (...args) => {
      if (blocked && (stage === 'index' ? String(args[0]).endsWith('index.jsonl') : /round-\d+\.json/.test(String(args[0])))) {
        throw Object.assign(new Error('injected storage failure'), { code });
      }
      return original(...args);
    });
    const mgr = new JobManager();
    const started = mgr.start(reviewRequest());
    const job = mgr.jobs.get(started.job_id);
    const execution = job.promise;
    await execution;
    const result = mgr.view(started.job_id);
    assert.equal(result.status, 'completed');
    assert.ok(result.result.findings.length);
    assert.equal(result.history_warning.stage, stage);
    assert.equal(result.history_warning.round_saved, stage === 'index');
    assert.equal(result.history_warning.index_saved, false);
    assert.equal(result.history_warning.recovery_saved, true);
    assert.equal(result.history_warning.code, code);
    assert.match(result.history_warning.recovery, /consult_get/);
    assert.equal(mgr.groupView(started.group_id).members[0].history_warning.stage, stage);
    assert.equal(pointsOf(result, ['f1']).history_warning.stage, stage);
    assert.equal(fs.existsSync(path.join(home, 'slots', `${started.job_id}.json`)), false);
    assert.equal(fs.existsSync(store.jobDir(started.job_id)), false);
    assert.equal(store.loadRunning(started.job_id).status, 'completed');

    // A different manager must find the terminal answer, not a fictitious running job.
    const restarted = new JobManager();
    restarted.sweepInterrupted();
    assert.equal(store.loadRunning(started.job_id).status, 'completed');
    assert.equal(restarted.view(started.job_id).status, 'completed');
    assert.equal(restarted.list().find((r) => r.job_id === started.job_id).status, 'completed');
    blocked = false;
    const recovered = restarted.view(started.job_id);
    assert.equal(recovered.status, 'completed');
    assert.deepEqual(recovered.result, result.result);
    assert.equal(recovered.history_warning, undefined);
    assert.equal(store.loadRunning(started.job_id), null);
    assert.equal(indexLines(started.job_id), 1);
    assert.equal(new JobManager().view(started.job_id).status, 'completed');
    assert.equal(mgr.jobs.get(started.job_id).promise, execution);
    mgr.view(started.job_id);
    assert.equal(indexLines(started.job_id), 1);
  });
}

test('when neither the round nor its recovery marker can be saved the owner warns about restart loss', async (t) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  const original = fs.writeFileSync;
  let blocked = true;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (blocked && /history[\\/](?:chain_|running)/.test(String(args[0]))) {
      throw Object.assign(new Error('injected permission failure'), { code: 'EACCES' });
    }
    return original(...args);
  });
  await mgr.jobs.get(started.job_id).promise;
  const result = mgr.view(started.job_id);
  assert.equal(result.status, 'completed');
  assert.equal(result.history_warning.recovery_saved, false);
  assert.match(result.history_warning.recovery, /before.*restart/i);
  assert.equal(store.loadRunning(started.job_id), null, 'a stale running marker must not survive a failed terminal write');
  blocked = false;
  assert.equal(mgr.view(started.job_id).history_warning, undefined);
  assert.equal(new JobManager().view(started.job_id).status, 'completed');
  assert.equal(indexLines(started.job_id), 1);
});

test('saving recovered history preserves checks another session writes after the owner reads its cached round', async (t) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const append = fs.appendFileSync;
  let blocked = true;
  t.mock.method(fs, 'appendFileSync', (...args) => {
    if (blocked && String(args[0]).endsWith('index.jsonl')) {
      throw Object.assign(new Error('injected index failure'), { code: 'ENOSPC' });
    }
    return append(...args);
  });
  const started = mgr.start(reviewRequest());
  const job = mgr.jobs.get(started.job_id);
  await job.promise;
  assert.equal(job.history_warning.stage, 'index');
  blocked = false;
  const other = new JobManager();
  other.view(started.job_id);
  const read = fs.readFileSync;
  let interleave = true;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const bytes = read(...args);
    if (interleave && args[0] === store.roundPath(job.chain_id, job.round)) {
      interleave = false;
      other.record({ job_id: started.job_id, entries: [{ id: 'f1', verdict: 'confirmed', note: 'Saved concurrently.' }] });
    }
    return bytes;
  });
  mgr.view(started.job_id);
  assert.equal(new JobManager().view(started.job_id).record.entries[0].note, 'Saved concurrently.');
  assert.equal(indexLines(started.job_id), 1);
});

test('a partially appended index row cannot hide recovered advice or the next completed consultation', async (t) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const append = fs.appendFileSync;
  let blocked = true;
  let partial = false;
  t.mock.method(fs, 'appendFileSync', (...args) => {
    if (blocked && String(args[0]).endsWith('index.jsonl')) {
      if (!partial) {
        partial = true;
        append(args[0], String(args[1]).slice(0, 25), args[2]);
      }
      throw Object.assign(new Error('injected partial index append'), { code: 'ENOSPC' });
    }
    return append(...args);
  });
  const damaged = mgr.start(reviewRequest());
  await mgr.jobs.get(damaged.job_id).promise;
  assert.equal(mgr.jobs.get(damaged.job_id).history_warning.stage, 'index');
  assert.equal(store.loadRunning(damaged.job_id).status, 'completed');
  blocked = false;

  // Another completed job must remain findable even before the damaged job
  // gets its own retry; a partial JSON tail must not swallow its index row.
  const next = mgr.start(reviewRequest());
  await mgr.jobs.get(next.job_id).promise;
  assert.equal(new JobManager().view(next.job_id)?.status, 'completed');
  const recovered = mgr.view(damaged.job_id);
  assert.equal(recovered.history_warning, undefined);
  assert.equal(new JobManager().view(damaged.job_id)?.status, 'completed');
  assert.equal(store.loadRunning(damaged.job_id), null);
  assert.equal(store.indexRows().filter((row) => row.job_id === damaged.job_id).length, 1);
  assert.equal(store.indexRows().filter((row) => row.job_id === next.job_id).length, 1);
  mgr.view(damaged.job_id);
  assert.equal(store.indexRows().filter((row) => row.job_id === damaged.job_id).length, 1);
});

test('a finished consultation is still found by another server process', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  await a.jobs.get(s.job_id).promise;

  const b = new JobManager();
  assert.equal(b.view(s.job_id).status, 'completed');
  assert.equal((await b.wait(s.job_id, 10)).status, 'completed');
  assert.match(b.cancel(s.job_id).cancel_effect, /already completed/);
  assert.equal(indexLines(s.job_id), 1, 'one index line per consultation');
  assert.equal(store.loadRunning(s.job_id), null, 'the in-progress marker is gone once it finishes');
});

test('a consultation running in another process is reported as running and left alone', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  const b = new JobManager();
  // Same process, other manager: the job is live here, so it is not interrupted.
  assert.ok(['queued', 'running'].includes(b.view(s.job_id).status));

  // As another process would see it: owned by a pid that is alive and not ours.
  const marker = store.loadRunning(s.job_id);
  store.writeRunning({ ...marker, owner: { ...marker.owner, pid: process.ppid } });
  const v = b.view(s.job_id);
  assert.notEqual(v.status, 'failed');
  assert.match(v.next_step, /another severally process.*consult_cancel/);
  assert.equal(v.cancellable, true, 'consult_cancel reaches the process running it');
  assert.match(b.cancel(s.job_id).cancel_effect, /asked the severally process running it/);
  assert.ok(store.loadRunning(s.job_id), 'a live owner keeps its marker');

  a.cancel(s.job_id);
  await a.jobs.get(s.job_id).promise;
});

test('a consultation whose process died reads as interrupted, written once', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  const marker = store.loadRunning(s.job_id);
  store.writeRunning({ ...marker, owner: { ...marker.owner, pid: deadPid() } });

  const b = new JobManager();
  const v = b.view(s.job_id);
  assert.equal(v.status, 'failed');
  assert.equal(v.failure.kind, 'interrupted');
  assert.equal(v.failure.retriable, true);
  assert.equal(store.loadRunning(s.job_id), null);
  assert.equal(new JobManager().view(s.job_id).failure.kind, 'interrupted', 'read back from the round file');
  assert.equal(indexLines(s.job_id), 1);

  a.cancel(s.job_id);
  await a.jobs.get(s.job_id).promise;
});

test('the startup sweep closes out what a dead process left running', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  const marker = store.loadRunning(s.job_id);
  store.writeRunning({ ...marker, owner: { ...marker.owner, pid: deadPid() } });
  new JobManager().sweepInterrupted();
  assert.equal(store.loadRunning(s.job_id), null);
  assert.equal(store.loadRound(s.job_id).failure.kind, 'interrupted');
  a.cancel(s.job_id);
  await a.jobs.get(s.job_id).promise;
});

test('shutdown kills a consultant that ignores SIGTERM before it returns', async () => {
  process.env.STUB_BEHAVIOR = 'ignore_term';
  const pidFile = path.join(home, 'stub.pid');
  process.env.STUB_GRANDCHILD_PID_OUT = pidFile;
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest());
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  delete process.env.STUB_GRANDCHILD_PID_OUT;

  // Shorter than SEVERALLY_KILL_GRACE_MS (500), so only shutdown's own SIGKILL can have done it.
  await mgr.shutdown(100);
  await waitFor(() => !alive(pid), { timeoutMs: 300 });
  assert.equal(alive(pid), false);
  await mgr.jobs.get(s.job_id).promise;
  assert.equal(mgr.view(s.job_id).status, 'cancelled');
});

test('an id shaped like a path is not looked up on disk', () => {
  const outside = path.join(home, 'outside.json');
  fs.writeFileSync(
    outside,
    JSON.stringify({
      job_id: 'job_000000000000',
      status: 'running',
      owner: { pid: deadPid(), deadline_at: new Date(0).toISOString() },
    }),
  );
  const mgr = new JobManager();
  assert.equal(mgr.view('../../outside'), null);
  assert.equal(mgr.cancel('../../outside'), null);
  assert.equal(mgr.groupView('../outside'), null);
  assert.ok(fs.existsSync(outside), 'nothing outside history was claimed or removed');
});

test('a crash between saving the answer and removing the marker keeps the answer', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  const marker = store.loadRunning(s.job_id);
  await a.jobs.get(s.job_id).promise;
  // As if the owner died right after persistRound, before removeRunning.
  store.writeRunning({ ...marker, owner: { ...marker.owner, pid: deadPid() } });
  new JobManager().sweepInterrupted();
  assert.equal(store.loadRound(s.job_id).status, 'completed');
  assert.equal(store.loadRunning(s.job_id), null);
  assert.equal(indexLines(s.job_id), 1);
});

test('an overdue owner is reported as interrupted, keeps its directory, and may still finish', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  await waitFor(() => a.jobs.get(s.job_id).status === 'running');
  const marker = store.loadRunning(s.job_id);
  store.writeRunning({ ...marker, owner: { pid: process.ppid, deadline_at: new Date(0).toISOString() } });
  const v = new JobManager().view(s.job_id);
  assert.equal(v.failure.kind, 'interrupted');
  assert.ok(fs.existsSync(store.jobDir(s.job_id)), 'a pid that is still alive keeps its working directory');
  assert.equal(a.view(s.job_id).status, 'running', 'the owner keeps managing its active process');
  assert.equal(a.list({ limit: 100 }).find((j) => j.job_id === s.job_id).status, 'running');
  a.cancel(s.job_id);
  await a.jobs.get(s.job_id).promise;
  assert.equal(store.loadRound(s.job_id).status, 'cancelled', "the owner's own close-out replaces it");
  assert.equal(indexLines(s.job_id), 1);
});

test('waiting on a consultation another process runs returns when it finishes', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  const marker = store.loadRunning(s.job_id);
  store.writeRunning({ ...marker, owner: { ...marker.owner, pid: process.ppid } });
  setTimeout(() => a.cancel(s.job_id), 300);
  const t0 = Date.now();
  const v = await new JobManager().wait(s.job_id, 10_000);
  assert.equal(v.status, 'cancelled');
  assert.ok(Date.now() - t0 < 5000, 'returned once it finished, not at the end of the wait');
});

// Seats other processes hold, written as they would write them.
const seat = (pid, deadlineMs = 3_600_000) => ({
  job_id: `job_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
  owner: { pid, deadline_at: new Date(Date.now() + deadlineMs).toISOString() },
});
const othersHold = (seats) => {
  fs.mkdirSync(path.join(home, 'slots'), { recursive: true });
  for (const s of seats) fs.writeFileSync(path.join(home, 'slots', `${s.job_id}.json`), JSON.stringify(s));
};
const clearSeats = () => fs.rmSync(path.join(home, 'slots'), { recursive: true, force: true });

test('busy admission returns a locked, bounded diagnosis without exposing other questions or process details', async () => {
  const { POLICY } = await import('../src/policy.mjs');
  clearSeats();
  const holders = Array.from({ length: POLICY.maxConcurrent }, () => seat(process.ppid));
  othersHold(holders);
  const mgr = new JobManager();
  let details;
  assert.throws(
    () => mgr.start(reviewRequest()),
    (err) => {
      assert.equal(err.code, 'concurrency_limit');
      assert.doesNotMatch(err.message, /or cancel it/i, 'do not suggest cancelling an unrelated holder');
      details = err.details;
      assert.equal(details.retryable, true);
      assert.equal(details.required, 1);
      assert.equal(details.in_use, POLICY.maxConcurrent);
      assert.equal(details.available, 0);
      assert.equal(details.limit, POLICY.maxConcurrent);
      assert.equal(details.missing, 1);
      assert.equal(details.retry_after_ms, 1000);
      assert.deepEqual(details.holders, [], 'do not invite fetching unrelated sessions and their briefs');
      assert.equal(details.elsewhere, POLICY.maxConcurrent);
      assert.equal(details.max_retries, 2);
      assert.equal(details.retry_budget_ms, 60000);
      return true;
    },
  );
  assert.equal(mgr.jobs.size, 0, 'rejected starts create no job or model call');
  store.releaseSeat(holders[0].job_id);
  process.env.STUB_BEHAVIOR = 'ok';
  const admitted = mgr.start(reviewRequest());
  await mgr.jobs.get(admitted.job_id).promise;
  assert.equal(mgr.jobs.size, 1, 'retry after release admits once');
  clearSeats();
});

test("busy admission names only this manager's already-known jobs as wait targets", async () => {
  const { POLICY } = await import('../src/policy.mjs');
  clearSeats();
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const own = mgr.start(reviewRequest());
  othersHold(Array.from({ length: POLICY.maxConcurrent - 1 }, () => seat(process.ppid)));
  assert.throws(
    () => mgr.start(reviewRequest()),
    (err) => {
      assert.deepEqual(err.details.holders, [{ job_id: own.job_id, state: 'alive' }]);
      assert.equal(err.details.elsewhere, POLICY.maxConcurrent - 1);
      return true;
    },
  );
  await mgr.jobs.get(own.job_id).promise;
  clearSeats();
});

test('oversized atomic seat requests are permanent configuration conditions, not promises to retry', () => {
  clearSeats();
  const seats = [seat(process.pid), seat(process.pid)];
  const result = store.takeSeats(seats, 1, () => true);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.required, 2);
  assert.equal(result.limit, 1);
  assert.deepEqual(result.holders, []);
  clearSeats();
});

test('the concurrency cap counts consultations other severally processes are running', async () => {
  const { POLICY } = await import('../src/policy.mjs');
  clearSeats();
  othersHold(Array.from({ length: POLICY.maxConcurrent - 1 }, () => seat(process.ppid)));
  process.env.STUB_BEHAVIOR = 'ok';
  const a = new JobManager();
  assert.throws(
    () => a.start(reviewRequest({ target: undefined, targets: ['codex', 'gemini'] })),
    (err) =>
      err.code === 'concurrency_limit' &&
      new RegExp(`${POLICY.maxConcurrent - 1} of the ${POLICY.maxConcurrent - 1} running are in other severally processes`).test(
        err.message,
      ),
  );
  // Refused whole: the seat the first member would have taken is free again.
  const s = a.start(reviewRequest());
  assert.throws(
    () => a.start(reviewRequest()),
    (err) => err.code === 'concurrency_limit',
  );
  await a.jobs.get(s.job_id).promise;
  // Finished, its seat is given back.
  const t = a.start(reviewRequest());
  await a.jobs.get(t.job_id).promise;
  clearSeats();
});

test('a seat whose process died, or that is past its deadline, is taken back', async () => {
  const { POLICY } = await import('../src/policy.mjs');
  clearSeats();
  const half = Math.floor(POLICY.maxConcurrent / 2);
  othersHold([
    ...Array.from({ length: half }, () => seat(deadPid())),
    ...Array.from({ length: POLICY.maxConcurrent - half }, () => seat(process.ppid, -1_000)),
  ]);
  process.env.STUB_BEHAVIOR = 'ok';
  const a = new JobManager();
  const s = a.start(reviewRequest({ target: undefined, targets: ['codex', 'gemini'] }));
  await Promise.all(s.jobs.map((j) => a.jobs.get(j.job_id).promise));
  assert.deepEqual(
    fs.readdirSync(path.join(home, 'slots')).filter((n) => n.endsWith('.json')),
    [],
    'the stale seats were removed',
  );
});

test('two processes taking the last seats at once cannot both get them', async () => {
  const { POLICY } = await import('../src/policy.mjs');
  clearSeats();
  const { spawn } = await import('node:child_process');
  const n = Math.ceil((POLICY.maxConcurrent + 1) / 2);
  // Each child takes n seats under its own pid and holds them until told to stop.
  const script = `
    const store = await import(${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)});
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const seats = Array.from({ length: ${n} }, (_, i) => ({ job_id: 'job_' + (process.pid * 100 + i).toString(16).padStart(12, '0').slice(-12), owner: { pid: process.pid, deadline_at: new Date(Date.now() + 60000).toISOString() } }));
    const r = store.takeSeats(seats, ${POLICY.maxConcurrent}, (s) => alive(s.owner.pid));
    process.stdout.write(JSON.stringify(r) + '\\n');
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env }));
  const results = await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve, reject) => {
          let out = '';
          c.stdout.on('data', (d) => {
            out += d;
            if (out.includes('\n')) resolve(JSON.parse(out));
          });
          c.on('error', reject);
          c.on('exit', (code) => reject(new Error(`child exited ${code} before answering`)));
        }),
    ),
  );
  for (const c of children) c.stdin.end();
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true], JSON.stringify(results));
  await Promise.all(children.map((c) => new Promise((resolve) => (c.exitCode !== null ? resolve() : c.on('exit', resolve)))));
  clearSeats();
});

test('two servers cannot both continue one consultation at once: the second follow-up is refused', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const a = new JobManager();
  const r1 = a.start(reviewRequest());
  await a.jobs.get(r1.job_id).promise;
  process.env.STUB_BEHAVIOR = 'hang';
  const r2 = a.start(reviewRequest({ followup_to: r1.job_id }));
  // Another server: nothing of A's in memory, and A's round 2 not yet on disk.
  const b = new JobManager();
  assert.throws(
    () => b.start(reviewRequest({ followup_to: r1.job_id })),
    (e) => e.code === 'followup_not_latest' && e.message.includes(r2.job_id),
  );
  a.cancel(r2.job_id);
  await a.jobs.get(r2.job_id).promise;
  // Once it is over, the retry from round 1 is allowed again, numbered after it.
  process.env.STUB_BEHAVIOR = 'ok';
  const r3 = b.start(reviewRequest({ followup_to: r1.job_id }));
  assert.equal(r3.round, 3);
  await b.jobs.get(r3.job_id).promise;
});

test("consult_list shows earlier sessions' consultations too, newest first, each once", async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const a = new JobManager();
  const one = a.start(reviewRequest());
  await a.jobs.get(one.job_id).promise;
  const fan = a.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await Promise.all(fan.jobs.map((j) => a.jobs.get(j.job_id).promise));

  const b = new JobManager();
  const mine = b.start(reviewRequest());
  await b.jobs.get(mine.job_id).promise;
  const listed = b.list({ limit: 4 });
  assert.equal(listed[0].job_id, mine.job_id, "this session's newest first");
  const ids = listed.map((j) => j.job_id);
  assert.equal(new Set(ids).size, ids.length, 'each consultation once');
  for (const j of fan.jobs) assert.ok(ids.includes(j.job_id), "an earlier session's fan-out is listed");
  const member = listed.find((j) => j.job_id === fan.jobs[0].job_id);
  assert.equal(member.group_id, fan.group_id);
  assert.match(member.summary, /Stub consultant summary/);
  assert.equal(member.status, 'completed');
  for (let i = 1; i < listed.length; i++) assert.ok(listed[i - 1].created_at >= listed[i].created_at);
  // What it lists can be used: recorded against from this session.
  b.record({ job_id: member.job_id, entries: [{ id: 'f1', verdict: 'confirmed' }] });
  assert.deepEqual(b.list({ limit: 4 }).find((j) => j.job_id === member.job_id).verdicts, { confirmed: 1 });
});

test('another server can cancel a consultation: it asks, and the server running it stops it', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  const b = new JobManager();
  // b holds nothing of a's in memory, as a separate process would not.
  const asked = b.cancel(s.job_id);
  assert.match(asked.cancel_effect, /asked the severally process running it/);
  const view = await a.jobs.get(s.job_id).promise.then(() => a.view(s.job_id));
  assert.equal(view.status, 'cancelled');
  assert.equal(store.cancelRequested(s.job_id), false, 'the request is consumed');
});

test('the cancel reaches a consultation that a separate server process runs', async () => {
  const { spawn } = await import('node:child_process');
  const jobsUrl = new URL('../src/jobs.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { JobManager } = await import(${JSON.stringify(jobsUrl)});
    const mgr = new JobManager();
    const s = mgr.start(${JSON.stringify(reviewRequest())});
    console.log(s.job_id);
    await mgr.jobs.get(s.job_id).promise;
    console.log(mgr.view(s.job_id).status);
  `,
    ],
    { env: { ...process.env, STUB_BEHAVIOR: 'hang' } },
  );
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  await waitFor(() => /job_\w+\n/.test(out), { timeoutMs: 8000 });
  const jobId = out.trim().split('\n')[0];
  assert.match(new JobManager().cancel(jobId).cancel_effect, /asked/);
  await new Promise((r) => child.on('exit', r));
  assert.equal(out.trim().split('\n').pop(), 'cancelled');
});

test("consult_list only reads: a dead server's consultation shows as interrupted and its marker stays", async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const s = a.start(reviewRequest());
  const marker = store.loadRunning(s.job_id);
  store.writeRunning({ ...marker, owner: { ...marker.owner, pid: deadPid() } });
  fs.appendFileSync(path.join(home, 'history', 'index.jsonl'), 'null\n42\n');
  const row = new JobManager().list({ limit: 100 }).find((j) => j.job_id === s.job_id);
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_kind, 'interrupted');
  assert.ok(store.loadRunning(s.job_id), 'listing wrote nothing');
  store.writeRunning(marker);
  a.cancel(s.job_id);
  await a.jobs.get(s.job_id).promise;
});

test('another server can cancel a whole fan-out it did not start', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const a = new JobManager();
  const fan = a.start(reviewRequest({ target: undefined, targets: ['codex', 'gemini'] }));
  const asked = new JobManager().cancelGroup(fan.group_id);
  assert.match(asked.cancel_effect, /asked the severally process running it to stop 2/);
  const views = await Promise.all(fan.jobs.map((j) => a.jobs.get(j.job_id).promise.then(() => a.view(j.job_id))));
  assert.deepEqual(
    views.map((v) => v.status),
    ['cancelled', 'cancelled'],
  );
});
