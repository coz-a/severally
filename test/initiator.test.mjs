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

const offers = () => fs.readFileSync(path.join(home, 'history', 'offers.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('initiator is optional, one of two values, and never gates anything', () => {
  assert.equal(parseRequest(reviewRequest()).initiator, null);
  assert.equal(parseRequest(reviewRequest({ initiator: 'user' })).initiator, 'user');
  assert.equal(parseRequest(reviewRequest({ initiator: 'offer_accepted' })).initiator, 'offer_accepted');
  assert.throws(() => parseRequest(reviewRequest({ initiator: 'agent' })), (err) => err.code === 'invalid_request');
});

test('who asked for a consultation is kept in the view, the round file, the index and the list', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest({ initiator: 'offer_accepted' })).job_id);
  assert.equal(view.status, 'completed');
  assert.equal(view.initiator, 'offer_accepted');
  const round = JSON.parse(fs.readFileSync(path.join(home, 'history', view.chain_id, 'round-01.json'), 'utf8'));
  assert.equal(round.initiator, 'offer_accepted');
  assert.equal(indexRow(view.job_id).initiator, 'offer_accepted');
  assert.equal(mgr.list().find((j) => j.job_id === view.job_id).initiator, 'offer_accepted');
});

test('an undeclared initiator is recorded as unknown, not guessed', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.initiator, null);
  assert.equal(indexRow(view.job_id).initiator, null);
});

test('a declined offer gets a masked line of its own and starts no consultation', () => {
  const mgr = new JobManager();
  const out = mgr.declineOffer({
    question: 'Should the migration run online? API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
    would_ask: 'codex',
    reason: 'not for this change',
  });
  assert.equal(mgr.order.length, 0, 'declining an offer must not create a job');
  const last = offers().at(-1);
  assert.equal(last.outcome, 'declined');
  assert.doesNotMatch(last.question, /sk-proj-abcdefghijklmnopqrstuvwx/);
  assert.equal(last.would_ask, 'codex');
  assert.equal(last.reason, 'not for this change');
  assert.ok(last.declined_at);
  assert.equal(out.offers_declined, offers().length);
  assert.equal(mgr.offersDeclined(), offers().length);
});
