import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { exportChain, ExportError } = await import('../src/export.mjs');

const finish = async (mgr, jobId) => {
  await mgr.jobs.get(jobId).promise;
  return mgr.view(jobId);
};

const consulted = async (over = {}) => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest(over));
  const view = await finish(mgr, started.job_id);
  return { mgr, view };
};

test('one consultation exports as one readable record: what was asked, answered, and checked', async () => {
  const { mgr, view } = await consulted();
  mgr.record({
    job_id: view.job_id,
    entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Capped the retries at 3.', note: 'Reproduced with a 30s outage.' }],
  });

  const { markdown } = exportChain({ chain_id: view.chain_id });
  assert.match(markdown, /Does the retry policy hold under a downstream outage\?/);
  assert.match(markdown, /Ship a retry policy that will not amplify an outage\./);
  assert.match(markdown, /The client retries 5 times with 100ms fixed backoff\./);
  assert.match(markdown, /Keep 5 retries but add jitter/);
  assert.match(markdown, /retry\.ts/);
  assert.match(markdown, /f1/);
  assert.match(markdown, /Retry storm risk/);
  assert.match(markdown, /The excerpt retries without a cap\./);
  assert.match(markdown, /confirmed/);
  assert.match(markdown, /Capped the retries at 3\./);
  assert.match(markdown, /Reproduced with a 30s outage\./);
  assert.match(markdown, /codex/);
  assert.match(markdown, /gpt-6.1-sol/);
});

test('a point nobody checked is shown as unchecked, not left out', async () => {
  const { view } = await consulted();
  const { markdown } = exportChain({ chain_id: view.chain_id });
  // The stub answers with one finding, one unknown and one next_check, none recorded.
  assert.match(markdown, /no verdict recorded/i);
  assert.doesNotMatch(markdown, /confirmed/);
});

test('a follow-up round is exported under the same record, in order', async () => {
  const { mgr, view } = await consulted();
  const second = mgr.start(reviewRequest({ followup_to: view.job_id }));
  const secondView = await finish(mgr, second.job_id);
  assert.equal(secondView.round, 2);

  const { markdown, rounds } = exportChain({ chain_id: view.chain_id });
  assert.equal(rounds, 2);
  assert.ok(markdown.indexOf('Round 1') < markdown.indexOf('Round 2'), 'rounds must read in order');
});

test('a fan-out exports every consultant separately, with no merged verdict', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['gpt', 'gemini'] }));
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));

  const { markdown } = exportChain({ group_id: started.group_id });
  assert.match(markdown, /codex/);
  assert.match(markdown, /antigravity/);
  assert.match(markdown, /Retry storm risk/);
  assert.match(markdown, /Unbounded retry/);
  // The server does not decide what the two answers add up to, and the export
  // is a record of what was said, not a conclusion drawn from it.
  assert.doesNotMatch(markdown, /consensus|both agree|おおむね一致/i);
});

test('a consultation that failed is exported as a failure, never as silence', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  const view = await finish(mgr, started.job_id);
  const { markdown } = exportChain({ chain_id: view.chain_id });
  assert.match(markdown, /usage_limit/);
  assert.match(markdown, /no advice/i);
});

test('exporting something that was never consulted is refused', () => {
  assert.throws(() => exportChain({ chain_id: 'chain_nope' }), ExportError);
  assert.throws(() => exportChain({}), ExportError);
});

test('a fan-out prints the shared brief once and says so, instead of repeating it per consultant', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['gpt', 'gemini'] }));
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));

  const { markdown } = exportChain({ group_id: started.group_id });
  const objective = 'Ship a retry policy that will not amplify an outage.';
  assert.equal(markdown.split(objective).length - 1, 1, 'a byte-identical brief is printed once');
  assert.match(markdown, /identical to the brief above/i);
  // Every consultant is still named with its own round, so the second answer
  // is never read as a continuation of the first.
  assert.equal((markdown.match(/^## Round 1/gm) ?? []).length, 2);
});

test('the exported record carries what the lead expected and what the answer added', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      prediction: { expected: 'proceed', worry: 'Only the retry cap really matters here.' },
    }),
  );
  const view = await finish(mgr, started.job_id);
  mgr.record({
    job_id: view.job_id,
    entries: [{ id: 'f1', verdict: 'confirmed' }],
    reflection: { delta: 'The cap was expected; the cascading-load framing was not.', related_item_ids: ['f1'] },
  });

  const { markdown } = exportChain({ chain_id: view.chain_id });
  assert.match(markdown, /Only the retry cap really matters here\./);
  assert.match(markdown, /The cap was expected; the cascading-load framing was not\./);
  // The prediction has to read as something written beforehand, or the record
  // invites exactly the "I knew that all along" rewrite it exists to prevent.
  assert.ok(
    markdown.indexOf('Only the retry cap really matters here.') < markdown.indexOf('Stub consultant summary'),
    'the prediction is printed before the answer it preceded',
  );
});

test('the export records which paths the consultant could read, without reprinting them', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-export-repo-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'retry.ts'), 'const everyLineOfIt = "do not reprint me";');

  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      context: { facts: ['f'], proposal: 'p', expose_paths: [path.join(repo, 'src')] },
    }),
  );
  const view = await finish(mgr, started.job_id);

  const { markdown } = exportChain({ chain_id: view.chain_id });
  assert.match(markdown, /Files exposed to the consultant/);
  assert.match(markdown, /workspace\/0-src/);
  assert.match(markdown, /directory, 1 file\(s\)/);
  assert.ok(markdown.includes(path.join(repo, 'src')), 'the record names where it came from');
  assert.ok(!markdown.includes('do not reprint me'), 'a manifest, not a dump');
});

test('the export tells a protected file left out apart from a skipped symlink', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-export-repo-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'retry.ts'), 'x');
  fs.writeFileSync(path.join(repo, 'src', '.env'), 'TOKEN=x');

  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      context: { facts: ['f'], proposal: 'p', expose_paths: [path.join(repo, 'src')] },
    }),
  );
  const view = await finish(mgr, started.job_id);

  const { markdown } = exportChain({ chain_id: view.chain_id });
  assert.match(markdown, /1 credential or history path\(s\) were left out on purpose/);
  assert.doesNotMatch(markdown, /symlink/);
});

test('export starts with checked points, evidence and effects, and links to their full rounds', async () => {
  const { mgr, view } = await consulted();
  mgr.record({
    job_id: view.job_id,
    entries: [
      { id: 'f1', verdict: 'confirmed', effect: 'Held the release pending a cap.', note: 'Observed retries in outage test.' },
      { id: 'u1', verdict: 'unverifiable', effect: 'Production load remains unknown.' },
    ],
  });
  const { markdown } = exportChain({ chain_id: view.chain_id });
  const summary = markdown.slice(0, markdown.indexOf('## Round'));
  assert.match(summary, /## Verification summary/);
  assert.match(summary, /confirmed/);
  assert.match(summary, /Held the release pending a cap\./);
  assert.match(summary, /Observed retries in outage test\./);
  assert.match(summary, /codex.*gpt-6.1-sol/);
  assert.ok(summary.includes(`[${view.job_id} / f1](#${view.job_id}-f1)`));
  assert.ok(markdown.includes(`<a id="${view.job_id}-f1"></a>`));
  assert.match(summary, /Unverified points: 2/);
  assert.doesNotMatch(summary, /adopted|accepted/i, 'confirmed is evidence, not an adoption decision');
  assert.match(markdown, /Production load remains unknown\./, 'full records retain unverifiable points');
});

test('verification summary counts unrecorded points across consultants without combining their judgements', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['gpt', 'gemini'] }));
  await Promise.all(started.jobs.map((j) => mgr.jobs.get(j.job_id).promise));
  const { markdown } = exportChain({ group_id: started.group_id });
  const summary = markdown.slice(0, markdown.indexOf('## Round'));
  assert.match(summary, /Unverified points: 6/);
  assert.match(summary, /No verified points recorded/);
  assert.doesNotMatch(summary, /confirmed|adopted|consensus/);
});

test('export of a retry preserves its source failure and supplied earlier context as distinct historical records', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const first = await finish(mgr, mgr.start(reviewRequest({ question: 'Original unique context for export' })).job_id);
  process.env.STUB_BEHAVIOR = 'auth';
  const failed = await finish(mgr, mgr.start({ followup_to: first.job_id, question: 'Failed question before export' }).job_id);
  process.env.STUB_BEHAVIOR = 'ok';
  const retried = await finish(mgr, mgr.start({ retry_of: failed.job_id }).job_id);
  const { markdown } = exportChain({ chain_id: retried.chain_id });
  assert.ok(markdown.includes(`retry_of: \`${failed.job_id}\``));
  assert.ok(markdown.includes(first.job_id));
  assert.ok(markdown.includes(first.chain_id));
  assert.match(markdown, /Original unique context for export/);
  assert.match(markdown, /Earlier retry records/);
  assert.match(markdown, /No advice was obtained: \*\*auth\*\*/);
  assert.equal(markdown.split(`<a id="${first.job_id}-f1"></a>`).length - 1, 1, 'historical points appear once');
});

test('retry export names source records that aged out instead of claiming their context is present', async () => {
  process.env.STUB_BEHAVIOR = 'auth';
  const mgr = new JobManager();
  const failed = await finish(mgr, mgr.start(reviewRequest()).job_id);
  process.env.STUB_BEHAVIOR = 'ok';
  const retried = await finish(mgr, mgr.start({ retry_of: failed.job_id }).job_id);
  const { roundPath } = await import('../src/store.mjs');
  fs.rmSync(roundPath(failed.chain_id, failed.round));
  const { markdown } = exportChain({ chain_id: retried.chain_id });
  assert.ok(markdown.includes(`Source job \`${failed.job_id}\` is no longer available in retained history.`));
  assert.ok(markdown.includes(`retry_of: \`${failed.job_id}\``));
});
