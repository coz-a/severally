import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandboxEnv, reviewRequest } from './helpers.mjs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { exportChain } = await import('../src/export.mjs');
const { createServer } = await import('../src/server.mjs');
const store = await import('../src/store.mjs');

const ALL = ['codex', 'claude-code', 'antigravity'];

async function finishedGroup(mgr = new JobManager()) {
  process.env.STUB_BEHAVIOR = 'ok';
  const started = mgr.start(reviewRequest({ target: undefined, targets: ALL }));
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  return { mgr, started, ids: started.jobs.map((j) => j.job_id) };
}

const verdict = (jobId, v = 'confirmed') => ({ job_id: jobId, entries: [{ id: 'f1', verdict: v, effect: `checked ${jobId}` }] });
const onDisk = (mgr, jobId) => store.loadRound(jobId).record;

test('every member of a fan-out is recorded in one call', async () => {
  const { mgr, ids } = await finishedGroup();
  const out = mgr.record({ records: ids.map((id) => verdict(id)) });
  assert.equal(out.saved, 3);
  assert.equal(out.not_saved, 0);
  assert.deepEqual(
    out.results.map((r) => r.job_id),
    ids,
  );
  for (const id of ids) assert.equal(onDisk(mgr, id).entries[0].verdict, 'confirmed');
});

test('one bad entry and nothing is written; every bad one is named', async () => {
  const { mgr, ids } = await finishedGroup();
  assert.throws(
    () =>
      mgr.record({
        records: [
          verdict(ids[0]),
          { job_id: ids[1], entries: [{ id: 'f99', verdict: 'confirmed' }] },
          { job_id: 'job_000000000000', entries: [{ id: 'f1', verdict: 'confirmed' }] },
        ],
      }),
    (e) => {
      assert.equal(e.code, 'invalid_records');
      assert.deepEqual(
        e.details.map((d) => [d.index, d.error]),
        [
          [1, 'unknown_entry_id'],
          [2, 'unknown_job'],
        ],
      );
      assert.match(e.message, /nothing was recorded/);
      return true;
    },
  );
  for (const id of ids) assert.equal(onDisk(mgr, id), null, 'the valid record was not written either');
});

test('a job named twice in one call is refused', async () => {
  const { mgr, ids } = await finishedGroup();
  assert.throws(
    () => mgr.record({ records: [verdict(ids[0]), verdict(ids[0])] }),
    (e) => e.code === 'invalid_records' && e.details[0].error === 'duplicate_job',
  );
});

test('recording the same id again replaces it, and a reflection can go alone', async () => {
  const { mgr, ids } = await finishedGroup();
  mgr.record({ records: ids.map((id) => verdict(id)) });
  mgr.record({ records: [verdict(ids[0], 'not_applicable'), { job_id: ids[1], reflection: { delta: 'nothing new' } }] });
  assert.equal(onDisk(mgr, ids[0]).entries.length, 1);
  assert.equal(onDisk(mgr, ids[0]).entries[0].verdict, 'not_applicable');
  assert.equal(store.loadRound(ids[1]).reflection.delta, 'nothing new');
  assert.equal(onDisk(mgr, ids[1]).entries[0].verdict, 'confirmed', 'a reflection leaves the verdicts as they were');
});

test('a fan-out from an earlier session is recorded and exported with its verdicts', async () => {
  const { started, ids } = await finishedGroup();
  const later = new JobManager();
  later.record({ records: ids.map((id) => verdict(id)) });
  const { markdown } = exportChain({ group_id: started.group_id });
  for (const id of ids) assert.match(markdown, new RegExp(`checked ${id}`));
});

test('a job whose write fails is reported as not saved; the others are saved', async () => {
  const { mgr, ids } = await finishedGroup();
  const j = mgr.jobs.get(ids[1]);
  const file = store.roundPath(j.chain_id, j.round);
  fs.rmSync(file);
  fs.mkdirSync(file);
  const out = mgr.record({ records: ids.map((id) => verdict(id)) });
  assert.equal(out.saved, 2);
  assert.equal(out.not_saved, 1);
  assert.equal(out.results[1].error, 'record_not_saved');
  assert.equal(mgr.view(ids[1]).record, null, 'a verdict that was not saved is not shown as recorded');
  assert.equal(onDisk(mgr, ids[0]).entries[0].verdict, 'confirmed');
});

test('over MCP, records is accepted, and cannot be mixed with job_id', async () => {
  const { server, manager } = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  const { ids } = await finishedGroup(manager);
  const res = await client.callTool({ name: 'consult_record', arguments: { records: ids.map((id) => verdict(id)) } });
  assert.notEqual(res.isError, true);
  assert.equal(JSON.parse(res.content[0].text).saved, 3);
  const mixed = await client.callTool({ name: 'consult_record', arguments: { job_id: ids[0], records: [verdict(ids[1])] } });
  assert.equal(mixed.isError, true);
  assert.equal(JSON.parse(mixed.content[0].text).error, 'unknown_field');
  await client.close();
});
