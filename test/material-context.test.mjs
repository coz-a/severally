import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { renderBrief } = await import('../src/brief.mjs');
const { parseRequest } = await import('../src/schema.mjs');

test('start reports the copied files, bytes and excluded paths before waiting for the answer', async () => {
  const dir = path.join(home, 'selected-material');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'implementation.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=synthetic\n');
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const start = mgr.start(reviewRequest({ context: { proposal: 'Keep it.', expose_paths: [dir] } }));
  assert.deepEqual(start.exposed_material.totals, { files: 1, bytes: Buffer.byteLength('export const value = 1;\n') });
  assert.equal(start.exposed_material.entries[0].source, dir);
  assert.equal(start.exposed_material.entries[0].files, 1);
  assert.ok(start.exposed_material.skipped.some((item) => item.reason === 'protected'));
  await mgr.jobs.get(start.job_id).promise;
});

test('an oversized selected file reports a partial size estimate without starting a consultation', () => {
  const dir = path.join(home, 'large-material');
  fs.mkdirSync(dir);
  const oversized = path.join(dir, 'large.bin');
  fs.writeFileSync(oversized, Buffer.alloc(6_000_000));
  const mgr = new JobManager();
  assert.throws(
    () => mgr.start(reviewRequest({ context: { proposal: 'Keep it.', expose_paths: [dir] } })),
    (err) => {
      assert.equal(err.code, 'expose_paths_too_large');
      assert.equal(err.details[0].partial, true);
      assert.equal(err.details[0].crossing.source, oversized);
      assert.equal(err.details[0].crossing.bytes, 6_000_000);
      assert.equal(err.details[0].observed.bytes, 6_000_000);
      assert.ok(err.details[0].limits.bytes < err.details[0].observed.bytes);
      return true;
    },
  );
  assert.equal(mgr.jobs.size, 0);
});

test('start bounds excluded path details while the full record retains them', async () => {
  const dir = path.join(home, 'many-exclusions');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'code.mjs'), 'export const x = 1;\n');
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `.env.${i}`), 'secret');
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const start = mgr.start(reviewRequest({ context: { proposal: 'Keep it.', expose_paths: [dir] } }));
  assert.equal(start.exposed_material.skipped.length, 20);
  assert.equal(start.exposed_material.skipped_counts.protected, 60);
  assert.equal(start.exposed_material.skipped_omitted, 40);
  await mgr.jobs.get(start.job_id).promise;
  assert.equal(mgr.view(start.job_id, { detail: 'full' }).brief.expose_paths.skipped.length, 60);
});

test('an empty exposed directory cannot be presented as sufficient code evidence', async () => {
  const empty = path.join(home, 'empty');
  fs.mkdirSync(empty);
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest({ context: { proposal: 'Keep the current implementation.', expose_paths: [empty] } }));
  await mgr.jobs.get(s.job_id).promise;
  const view = mgr.view(s.job_id);
  assert.equal(view.brief.exposed.files, 0);
  assert.match(view.brief.exposed.action_needed, /missing|zero|no files/i);
  const full = mgr.view(s.job_id, { detail: 'full' });
  const brief = renderBrief(
    parseRequest(reviewRequest()),
    { round: 1, priorRounds: [] },
    { entries: [], totals: { files: 0, bytes: 0 }, skipped: [] },
  );
  assert.match(brief, /0 files|zero files|no files/i);
  assert.equal(full.brief.expose_paths.totals.files, 0);
});

test('followup asks for changed premises, retained or withdrawn advice and concrete changes/checks', () => {
  const req = parseRequest({
    target: 'codex',
    question: 'Payments use POST, timeout may follow commit, and no idempotency is available.',
  });
  const text = renderBrief(req, {
    round: 2,
    priorRounds: [
      {
        round: 1,
        mode: 'explore',
        question: 'How should GET retries work?',
        summary: 'Retry safe GETs.',
        recommendation: 'Use bounded GET retries.',
        findings: [],
        unknowns: [],
        next_checks: [],
      },
    ],
  });
  assert.match(text, /Your recommendation: Use bounded GET retries\./);
  assert.match(text, /changed premise/i);
  assert.match(text, /keep.*retract|retain.*withdraw/i);
  assert.match(text, /concrete.*change.*check/i);
});
