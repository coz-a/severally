import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandboxEnv, reviewRequest, exploreRequest, waitFor } from './helpers.mjs';

const home = sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const { POLICY } = await import('../src/policy.mjs');

const finish = async (mgr, jobId) => {
  const job = mgr.jobs.get(jobId);
  await job.promise;
  return mgr.view(jobId);
};

test('codex consultation: end-to-end success path', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  assert.equal(started.target, 'codex');
  assert.equal(started.round, 1);
  assert.equal(started.model, POLICY.targets.codex.model);
  assert.equal(started.rounds_remaining, 2);

  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.equal(view.failure, null);
  assert.match(view.result.summary, /Stub consultant summary/);
  assert.equal(view.result.findings[0].severity, 'high');
  assert.equal(view.result.alternatives.length, 1);
  assert.equal(view.result.next_checks.length, 1);
  assert.equal(view.usage.input_tokens, 1200);
  assert.equal(view.usage.output_tokens, 450);
  assert.equal(view.usage.cost_usd, null, 'codex reports no cost; it must not be invented');
  assert.ok(view.duration_ms >= 0);
  assert.equal(view.quality.evidence_basis, 'sufficient');
});

test('claude-code consultation: usage recorded, thin evidence flagged', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(exploreRequest());
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.equal(view.usage.cost_usd, 0.0421);
  assert.equal(view.usage.web_search_requests, 3);
  assert.equal(view.quality.evidence_basis, 'thin');
  assert.equal(view.quality.findings_without_grounds, 1);
  assert.match(view.quality.caveat, /thin evidence/);
  assert.match(view.quality.caveat, /without grounds/);
  assert.equal(view.result.remaining_disagreements.length, 1, 'disagreement must survive, not be smoothed away');
});

test('the consultant is launched with the restriction flags and none that widen permissions', async () => {
  const argvOut = path.join(os.tmpdir(), `pc-argv-${Date.now()}.json`);
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_ARGV_OUT = argvOut;
  const mgr = new JobManager();
  await finish(mgr, mgr.start(reviewRequest()).job_id);
  const codexArgs = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check']) {
    assert.ok(codexArgs.includes(flag), `codex must be launched with ${flag}`);
  }
  assert.equal(codexArgs[codexArgs.indexOf('-s') + 1], 'read-only');
  assert.ok(codexArgs.includes('tools.web_search=true'));
  assert.ok(codexArgs.includes('hooks.enabled=false'));
  for (const flag of ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--add-dir']) {
    assert.ok(!codexArgs.includes(flag), `codex must never be launched with ${flag}`);
  }

  await finish(mgr, mgr.start(exploreRequest()).job_id);
  const claudeArgs = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
    assert.ok(claudeArgs.includes(flag), `claude must be launched with ${flag}`);
  }
  assert.equal(claudeArgs[claudeArgs.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(claudeArgs[claudeArgs.indexOf('--permission-prompts') + 1], 'none');
  for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--mcp-config', '--add-dir', '--plugin-dir']) {
    assert.ok(!claudeArgs.includes(flag), `claude must never be launched with ${flag}`);
  }
  delete process.env.STUB_ARGV_OUT;
  fs.rmSync(argvOut, { force: true });
});

test('the child environment carries the recursion marker and drops the parent session wiring', async () => {
  const envOut = path.join(os.tmpdir(), `pc-env-${Date.now()}.json`);
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_ENV_OUT = envOut;
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'parent-token';
  process.env.CLAUDECODE = '1';
  const mgr = new JobManager();
  await finish(mgr, mgr.start(reviewRequest()).job_id);
  const childEnvSeen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
  assert.equal(childEnvSeen.PEER_CONSULT_ACTIVE, '1');
  assert.equal(childEnvSeen.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.equal(childEnvSeen.CLAUDECODE, undefined);
  assert.equal(childEnvSeen.PEER_CONSULT_HOME, undefined, 'server-only config must not leak into the consultant');
  delete process.env.STUB_ENV_OUT;
  delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete process.env.CLAUDECODE;
  fs.rmSync(envOut, { force: true });
});

test('the brief carries the material and the hard rules, and no proposal in explore round 1', async () => {
  const briefOut = path.join(os.tmpdir(), `pc-brief-${Date.now()}.txt`);
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_BRIEF_OUT = briefOut;
  const mgr = new JobManager();
  await finish(mgr, mgr.start(exploreRequest()).job_id);
  const brief = fs.readFileSync(briefOut, 'utf8');
  assert.match(brief, /MODE: explore/);
  assert.match(brief, /must not modify, create or delete any file/);
  assert.match(brief, /must not start, request or delegate another consultation/);
  assert.match(brief, /Writes currently go straight to Postgres/);
  assert.ok(!/Current proposal/.test(brief), 'explore round 1 must not reveal a proposal section');
  delete process.env.STUB_BRIEF_OUT;
  fs.rmSync(briefOut, { force: true });
});

test('secrets are scrubbed from the consultant answer', async () => {
  process.env.STUB_BEHAVIOR = 'leak_secret';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.status, 'completed');
  assert.ok(!/sk-ant-api03-AAAABBBB/.test(JSON.stringify(view)), 'API key must not survive into the result');
  assert.match(view.result.summary, /REDACTED/);
});

test('malformed output is a failure, not a silent success', async () => {
  process.env.STUB_BEHAVIOR = 'invalid';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'invalid_output');
  assert.equal(view.result, null);
  assert.equal(view.failure.delivered_advice, false);
});

test('usage limits and auth failures are classified, not reported as advice', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  let mgr = new JobManager();
  let view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'usage_limit');
  assert.match(view.next_step, /never answered/);

  process.env.STUB_BEHAVIOR = 'auth';
  mgr = new JobManager();
  view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.failure.kind, 'auth');

  process.env.STUB_BEHAVIOR = 'model_unavailable';
  mgr = new JobManager();
  view = await finish(mgr, mgr.start(exploreRequest()).job_id);
  assert.equal(view.failure.kind, 'model_unavailable');

  process.env.STUB_BEHAVIOR = 'crash';
  mgr = new JobManager();
  view = await finish(mgr, mgr.start(exploreRequest()).job_id);
  assert.equal(view.failure.kind, 'cli_error');
  assert.equal(view.failure.retriable, true);
});

test('a hung consultant hits the timeout and is stopped', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.PEER_CONSULT_TIMEOUT_MS = '1500';
  const { JobManager: TimedManager } = await import(`../src/jobs.mjs?timeout=${Date.now()}`);
  const mgr = new TimedManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'timeout');
  assert.equal(view.failure.retriable, true);
  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
});

test('cancel stops the consultant and every process it spawned', async () => {
  const pidOut = path.join(os.tmpdir(), `pc-gc-${Date.now()}.pid`);
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.STUB_GRANDCHILD_PID_OUT = pidOut;
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  const grandchildPid = Number(await waitFor(() => (fs.existsSync(pidOut) ? fs.readFileSync(pidOut, 'utf8') : null)));
  assert.ok(grandchildPid > 0);
  process.kill(grandchildPid, 0); // alive

  const cancelView = mgr.cancel(started.job_id);
  assert.equal(cancelView.status, 'cancelling');
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'cancelled');
  assert.equal(view.failure.kind, 'cancelled');

  await waitFor(() => {
    try { process.kill(grandchildPid, 0); return false; } catch { return true; }
  }, { timeoutMs: 8000 });
  delete process.env.STUB_GRANDCHILD_PID_OUT;
  fs.rmSync(pidOut, { force: true });
});

test('rounds are capped at 1 initial + 2 follow-ups per chain', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const r1 = mgr.start(reviewRequest());
  await finish(mgr, r1.job_id);
  const r2 = mgr.start(reviewRequest({ followup_to: r1.job_id }));
  assert.equal(r2.round, 2);
  assert.equal(r2.chain_id, r1.chain_id);
  await finish(mgr, r2.job_id);
  const r3 = mgr.start(reviewRequest({ followup_to: r2.job_id }));
  assert.equal(r3.round, 3);
  await finish(mgr, r3.job_id);
  assert.throws(
    () => mgr.start(reviewRequest({ followup_to: r3.job_id })),
    (err) => err.code === 'round_limit',
  );
});

test('a follow-up brief carries the earlier rounds and cannot cross targets', async () => {
  const briefOut = path.join(os.tmpdir(), `pc-brief2-${Date.now()}.txt`);
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const r1 = mgr.start(reviewRequest());
  await finish(mgr, r1.job_id);
  assert.throws(
    () => mgr.start(exploreRequest({ followup_to: r1.job_id })),
    (err) => err.code === 'followup_target_mismatch',
  );
  process.env.STUB_BRIEF_OUT = briefOut;
  const r2 = mgr.start(reviewRequest({ followup_to: r1.job_id }));
  await finish(mgr, r2.job_id);
  const brief = fs.readFileSync(briefOut, 'utf8');
  assert.match(brief, /Earlier rounds of this same consultation/);
  assert.match(brief, /Stub consultant summary/);
  assert.match(brief, /Retry storm risk/);
  delete process.env.STUB_BRIEF_OUT;
  fs.rmSync(briefOut, { force: true });
});

test('follow-up to an unfinished or unknown job is refused', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.PEER_CONSULT_TIMEOUT_MS = '1200';
  const { JobManager: M } = await import(`../src/jobs.mjs?fu=${Date.now()}`);
  const mgr = new M();
  const r1 = mgr.start(reviewRequest());
  assert.throws(() => mgr.start(reviewRequest({ followup_to: r1.job_id })), (e) => e.code === 'followup_not_completed');
  assert.throws(() => mgr.start(reviewRequest({ followup_to: 'job_nope' })), (e) => e.code === 'unknown_job');
  mgr.cancel(r1.job_id);
  await finish(mgr, r1.job_id);
  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
});

test('concurrency is capped server-side', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.PEER_CONSULT_TIMEOUT_MS = '1200';
  const { JobManager: M } = await import(`../src/jobs.mjs?cc=${Date.now()}`);
  const mgr = new M();
  const a = mgr.start(reviewRequest());
  const b = mgr.start(reviewRequest());
  assert.throws(() => mgr.start(reviewRequest()), (e) => e.code === 'concurrency_limit');
  mgr.shutdown();
  await Promise.all([finish(mgr, a.job_id), finish(mgr, b.job_id)]);
  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
});

test('a consultation cannot be started from inside a consultant session', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  process.env.PEER_CONSULT_ACTIVE = '1';
  try {
    assert.throws(() => mgr.start(reviewRequest()), (e) => e.code === 'recursion_blocked');
  } finally {
    delete process.env.PEER_CONSULT_ACTIVE;
  }
});

test('history is persisted and the working directory is cleaned up', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  await finish(mgr, started.job_id);
  const chainDir = path.join(home, 'history', started.chain_id);
  const files = fs.readdirSync(chainDir);
  assert.deepEqual(files, ['round-01.json']);
  const record = JSON.parse(fs.readFileSync(path.join(chainDir, files[0]), 'utf8'));
  assert.equal(record.status, 'completed');
  assert.equal(record.job_id, started.job_id);
  assert.ok(fs.existsSync(path.join(home, 'history', 'index.jsonl')));
  assert.ok(!fs.existsSync(path.join(home, 'jobs', started.job_id)), 'per-job scratch must be removed');
});

test('the launch guard refuses permission-widening flags outright', async () => {
  const { assertNoForbiddenFlags } = await import('../src/jobs.mjs');
  assert.equal(assertNoForbiddenFlags('codex', ['exec', '-s', 'read-only']), true);
  assert.throws(() => assertNoForbiddenFlags('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox']), /permission-widening/);
  assert.throws(() => assertNoForbiddenFlags('claude-code', ['-p', '--dangerously-skip-permissions']), /permission-widening/);
  assert.throws(() => assertNoForbiddenFlags('claude-code', ['-p', '--add-dir', '/']), /permission-widening/);
});
