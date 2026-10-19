import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { parseRequest } = await import('../src/schema.mjs');

const finish = async (mgr, jobId) => {
  await mgr.jobs.get(jobId).promise;
  return mgr.view(jobId);
};

const indexRow = (jobId) => fs.readFileSync(path.join(home, 'history', 'index.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.job_id === jobId);

test('initiator is optional, "user" or nothing, and never gates anything', () => {
  assert.equal(parseRequest(reviewRequest()).initiator, null);
  assert.equal(parseRequest(reviewRequest({ initiator: 'user' })).initiator, 'user');
  // An older Skill still sends this; its consultation starts, read as not declared.
  assert.equal(parseRequest(reviewRequest({ initiator: 'offer_accepted' })).initiator, null);
  assert.throws(() => parseRequest(reviewRequest({ initiator: 'agent' })), (err) => err.code === 'invalid_request');
});

test('who asked for a consultation is kept in the view, the round file, the index and the list', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest({ initiator: 'user' })).job_id);
  assert.equal(view.status, 'completed');
  assert.equal(view.initiator, 'user');
  const round = JSON.parse(fs.readFileSync(path.join(home, 'history', view.chain_id, 'round-01.json'), 'utf8'));
  assert.equal(round.initiator, 'user');
  assert.equal(indexRow(view.job_id).initiator, 'user');
  assert.equal(mgr.list().find((j) => j.job_id === view.job_id).initiator, 'user');
});

test('an undeclared initiator is recorded as unknown, not guessed', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.initiator, null);
  assert.equal(indexRow(view.job_id).initiator, null);
});

