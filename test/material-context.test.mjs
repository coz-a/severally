import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { renderBrief } = await import('../src/brief.mjs');
const { parseRequest } = await import('../src/schema.mjs');

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
