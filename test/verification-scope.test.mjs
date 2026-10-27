import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { exportChain } = await import('../src/export.mjs');
const { loadRound } = await import('../src/store.mjs');

for (const verdict of ['confirmed', 'refuted', 'unverified', 'not_applicable', 'unverifiable']) {
  test(`${verdict} retains the checked scope through list, history, export and followup after restart`, async (t) => {
    process.env.STUB_BEHAVIOR = 'ok';
    const mgr = new JobManager();
    const start = mgr.start(reviewRequest());
    await mgr.jobs.get(start.job_id).promise;
    const note =
      verdict === 'unverified'
        ? 'Synthetic cache-key collision reproduced; authentication location was not supplied or verified.'
        : 'Synthetic fixture only, Node.js; this check addresses the cache key and does not locate authentication.';
    mgr.record({ job_id: start.job_id, entries: [{ id: 'f1', verdict, note, effect: 'Keep the authentication claim open.' }] });
    const restarted = new JobManager();
    assert.equal(restarted.list().find((j) => j.job_id === start.job_id).verdicts[verdict], 1);
    assert.equal(loadRound(start.job_id).record.entries[0].note, note);
    const markdown = exportChain({ chain_id: start.chain_id }).markdown;
    assert.match(markdown, new RegExp(`checked: ${verdict}`));
    assert.ok(markdown.includes(note));
    if (verdict === 'refuted') assert.match(markdown.split('### Question')[0], /round 1: refuted/);
    const output = path.join(home, `followup-${verdict}.txt`);
    process.env.STUB_BRIEF_OUT = output;
    t.after(() => {
      delete process.env.STUB_BRIEF_OUT;
    });
    const child = restarted.start({ followup_to: start.job_id, question: 'What can be concluded from this check alone?' });
    await restarted.jobs.get(child.job_id).promise;
    const brief = fs.readFileSync(output, 'utf8');
    assert.ok(brief.includes(`lead's verdict: ${verdict}`));
    assert.ok(brief.includes(note), 'the evidence and its limits must travel with the verdict');
    assert.match(brief, /refuted:.*did not hold/);
  });
}

test('followup evidence notes are bounded and visibly truncated', async (t) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest());
  await mgr.jobs.get(s.job_id).promise;
  mgr.record({
    job_id: s.job_id,
    entries: [{ id: 'f1', verdict: 'unverified', note: `only-collision-checked ${'x'.repeat(2000)} hidden-tail` }],
  });
  process.env.STUB_BRIEF_OUT = path.join(home, 'bounded-note.txt');
  assert.ok(loadRound(s.job_id).record.entries[0].followup_note.length <= 400);
  t.after(() => {
    delete process.env.STUB_BRIEF_OUT;
  });
  const next = mgr.start({ followup_to: s.job_id, question: 'Revisit only the missing authentication premise.' });
  await mgr.jobs.get(next.job_id).promise;
  const brief = fs.readFileSync(process.env.STUB_BRIEF_OUT, 'utf8');
  assert.match(brief, /only-collision-checked/);
  assert.match(brief, /truncated/);
  assert.doesNotMatch(brief, /hidden-tail/);
});

test('notes from legacy history remain local until explicitly recorded again', async (t) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest());
  await mgr.jobs.get(s.job_id).promise;
  mgr.record({ job_id: s.job_id, entries: [{ id: 'f1', verdict: 'confirmed', note: 'legacy-local-only-evidence' }] });
  const store = await import('../src/store.mjs');
  const saved = store.loadRound(s.job_id);
  delete saved.record.entries[0].followup_note;
  store.persistRound(saved, { appendIndex: false });
  const output = path.join(home, 'legacy-note.txt');
  process.env.STUB_BRIEF_OUT = output;
  t.after(() => {
    delete process.env.STUB_BRIEF_OUT;
  });
  const restarted = new JobManager();
  const next = restarted.start({ followup_to: s.job_id, question: 'Continue without republishing local legacy notes.' });
  await restarted.jobs.get(next.job_id).promise;
  assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /legacy-local-only-evidence/);
  assert.equal(store.loadRound(s.job_id).record.entries[0].note, 'legacy-local-only-evidence');
});
