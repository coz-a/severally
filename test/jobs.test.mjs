import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  sandboxEnv,
  reviewRequest,
  exploreRequest,
  debateRequest,
  antigravityRequest,
  opencodeRequest,
  waitFor,
} from './helpers.mjs';

// The four default consultants plus a second one on Codex, so a test can ask
// a consultant that shares its CLI with another. POLICY freezes at first
// import, so the config has to be in place here rather than inside the test.
const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'severally-jobs-')), 'config.json');
fs.writeFileSync(
  cfgFile,
  JSON.stringify({
    consultants: {
      codex: { cli: 'codex', model: 'gpt-6-astra' },
      'claude-code': { cli: 'claude-code', model: 'claude-opus-5-5' },
      antigravity: { cli: 'antigravity', model: 'gemini-4-argon-high' },
      opencode: { cli: 'opencode', model: 'zai-coding-plan/glm-5.3' },
      mini: { cli: 'codex', model: 'gpt-6-astra-mini' },
    },
  }),
);
const home = sandboxEnv({ SEVERALLY_CONFIG: cfgFile });
const { JobManager } = await import('../src/jobs.mjs');
const { consultantByName } = await import('../src/policy.mjs');

// node:sqlite ships unflagged from Node 23 (and late 22.x); without it the
// credential seeding behind the opencode retry is a no-op, and so are the
// tests that rely on it.
let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

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
  assert.equal(started.model, consultantByName('codex').model);
  assert.equal(started.rounds_remaining, 4);

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

test('a same-vendor consultation is delivered with an independence caveat', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: 'codex', caller: 'codex' }));
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.match(view.quality.caveat, /same vendor|independen/i);
  assert.equal(view.caller, 'codex');
  // In a live check, "prefer the other two" was read as "discard this one":
  // leads put the same-vendor consultant's findings under Rejected without
  // checking their grounds. The caveat has to say what a re-read removes and
  // what it keeps, and must not read as a verdict on the answer's content.
  assert.match(view.quality.caveat, /session|history/i);
  assert.match(view.quality.caveat, /lineage|blind spots/i);
  assert.match(view.quality.caveat, /grounds/i);
  assert.doesNotMatch(view.quality.caveat, /prefer the other/i);
});

test('a cross-vendor consultation carries no independence caveat', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest({ caller: 'claude-code' })).job_id);
  assert.equal(/same vendor/i.test(view.quality.caveat ?? ''), false);
});

test('with no caller in the request and no host markers in the environment, no caller is detected or recorded', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.caller, null);
  assert.equal(/same vendor/i.test(view.quality.caveat ?? ''), false);
});

test('the consultant is launched with the restriction flags and none that widen permissions', async () => {
  const argvOut = path.join(os.tmpdir(), `pc-argv-${Date.now()}.json`);
  // A signed-in Codex has its home; on Windows a missing protected path is not passed.
  fs.mkdirSync(path.join(os.homedir(), '.codex'), { recursive: true });
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_ARGV_OUT = argvOut;
  const mgr = new JobManager();
  await finish(mgr, mgr.start(reviewRequest()).job_id);
  const codexArgs = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check']) {
    assert.ok(codexArgs.includes(flag), `codex must be launched with ${flag}`);
  }
  assert.ok(!codexArgs.includes('-s'), '-s read-only would replace the permission profile');
  assert.ok(codexArgs.includes('default_permissions="severally"'));
  const fsRules = codexArgs.find((a) => a.startsWith('permissions.severally.filesystem='));
  assert.match(fsRules, /":root" = "read"/);
  assert.ok(fsRules.includes(`${JSON.stringify(path.join(os.homedir(), '.ssh').replaceAll('\\', '/'))} = "none"`));
  assert.ok(
    fsRules.includes(`${JSON.stringify(fs.realpathSync.native(path.join(home, 'homes')).replaceAll('\\', '/'))} = "none"`),
  );
  const defaultCodexHome = path.join(os.homedir(), '.codex');
  const codexHomeRoot = fs.existsSync(defaultCodexHome) ? fs.realpathSync.native(defaultCodexHome) : defaultCodexHome;
  assert.ok(
    fsRules.includes(`${JSON.stringify(codexHomeRoot.replaceAll('\\', '/'))} = "none"`),
    'the stub executable lives outside ~/.codex, so its credentials are denied as a directory',
  );
  assert.ok(codexArgs.includes('tools.web_search=true'));
  assert.ok(codexArgs.includes('hooks.enabled=false'));
  assert.ok(codexArgs.includes('shell_environment_policy.inherit="core"'));
  // inherit="none" strips the recursion marker from anything Codex launches
  // from its shell, so it has to be put back explicitly.
  assert.ok(
    codexArgs.includes('shell_environment_policy.set={SEVERALLY_ACTIVE="1"}'),
    "the recursion marker must reach the consultant's own shell",
  );
  for (const flag of ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--add-dir']) {
    assert.ok(!codexArgs.includes(flag), `codex must never be launched with ${flag}`);
  }

  await finish(mgr, mgr.start(exploreRequest()).job_id);
  const claudeArgs = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
    assert.ok(claudeArgs.includes(flag), `claude must be launched with ${flag}`);
  }
  // Read/Glob/Grep are provisioned on purpose: Codex's child could always read
  // the disk, and a fan-out whose members read different amounts is not one.
  // Nothing that writes or executes is in the list.
  const claudeTools = claudeArgs[claudeArgs.indexOf('--tools') + 1].split(',');
  assert.deepEqual(claudeTools, ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);
  for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
    assert.ok(!claudeTools.includes(tool), `claude must never be given ${tool}`);
  }
  assert.equal(claudeArgs[claudeArgs.indexOf('--permission-prompts') + 1], 'none');
  // With --permission-mode manual and --permission-prompts none, a tool with no
  // allow rule is denied outright: without this the consultant had no web at all.
  // Only the two web tools get a rule, so nothing that writes is ever allowed.
  const claudeAllowed = claudeArgs[claudeArgs.indexOf('--allowedTools') + 1].split(',');
  assert.deepEqual(claudeAllowed, ['WebSearch', 'WebFetch']);
  for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--mcp-config', '--plugin-dir']) {
    assert.ok(!claudeArgs.includes(flag), `claude must never be launched with ${flag}`);
  }
  // --restricted confines the file tools to the (empty) working directory, so
  // the read scope is widened to the whole disk -- once, and to nothing else.
  assert.deepEqual(
    claudeArgs.flatMap((a, i) => (a === '--add-dir' ? [claudeArgs[i + 1]] : [])),
    ['/'],
  );
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
  assert.equal(childEnvSeen.SEVERALLY_ACTIVE, '1');
  assert.equal(childEnvSeen.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.equal(childEnvSeen.CLAUDECODE, undefined);
  assert.equal(childEnvSeen.SEVERALLY_HOME, undefined, 'server-only config must not leak into the consultant');
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

test('a Codex error the turn recovered from keeps the answer, with a caveat; a failed turn does not', async () => {
  const run = async (behavior) => {
    process.env.STUB_BEHAVIOR = behavior;
    const mgr = new JobManager();
    return finish(mgr, mgr.start(reviewRequest()).job_id);
  };
  let view = await run('recovered_ok');
  assert.equal(view.status, 'completed');
  assert.match(view.quality.caveat, /reported an error mid-run.*Rate limit reached/);

  view = await run('recovered_failed');
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'rate_limited');

  // No answer, or one that does not parse: the error stands, with its own kind.
  for (const behavior of ['recovered_none', 'recovered_invalid']) {
    view = await run(behavior);
    assert.equal(view.status, 'failed', behavior);
    assert.equal(view.failure.kind, 'rate_limited', behavior);
    assert.equal(view.result, null, behavior);
    // A transient error is re-run, whether or not an unreadable answer followed it.
    assert.ok(view.retries.length > 0, behavior);
  }
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

test('an auth error mixed with a 429 is not retried and keeps other fan-out answers', async () => {
  process.env.STUB_BEHAVIOR = 'auth_mixed';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await Promise.all(started.jobs.map((job) => mgr.jobs.get(job.job_id).promise));

  const codex = mgr.view(started.jobs[0].job_id);
  const claude = mgr.view(started.jobs[1].job_id);
  assert.equal(codex.failure.kind, 'auth');
  assert.deepEqual(codex.retries, []);
  assert.equal(claude.status, 'completed');
  assert.equal(claude.result.summary, 'Stub Claude Code consultant view.');

  const group = mgr.groupView(started.group_id);
  assert.equal(group.status, 'done');
  assert.equal(group.comparison.by_target.find((member) => member.target === 'codex').summary, null);
  assert.equal(
    group.comparison.by_target.find((member) => member.target === 'claude-code').summary,
    'Stub Claude Code consultant view.',
  );
});

test('a hung consultant hits the timeout and is stopped', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.SEVERALLY_TIMEOUT_MS = '1500';
  const { JobManager: TimedManager } = await import(`../src/jobs.mjs?timeout=${Date.now()}`);
  const mgr = new TimedManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'timeout');
  assert.equal(view.failure.retriable, true);
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
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

  await waitFor(
    () => {
      try {
        process.kill(grandchildPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { timeoutMs: 8000 },
  );
  delete process.env.STUB_GRANDCHILD_PID_OUT;
  fs.rmSync(pidOut, { force: true });
});

test('rounds are capped at 1 initial + 4 follow-ups per chain by default', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const r1 = mgr.start(reviewRequest());
  await finish(mgr, r1.job_id);
  let last = r1;
  for (let round = 2; round <= 5; round++) {
    last = mgr.start(reviewRequest({ followup_to: last.job_id }));
    assert.equal(last.round, round);
    assert.equal(last.chain_id, r1.chain_id);
    assert.equal(last.rounds_remaining, 5 - round);
    assert.equal((await finish(mgr, last.job_id)).status, 'completed');
  }
  assert.throws(
    () => mgr.start(reviewRequest({ followup_to: last.job_id })),
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

test('a follow-up brief carries grounds, unknowns and checks with their verdicts, tagged by round', async () => {
  const briefOut = path.join(os.tmpdir(), `pc-brief4-${Date.now()}.txt`);
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const r1 = mgr.start(reviewRequest());
  await finish(mgr, r1.job_id);
  mgr.record({ job_id: r1.job_id, entries: [{ id: 'c1', verdict: 'confirmed', effect: 'Replayed; p99 held.' }] });
  process.env.STUB_BRIEF_OUT = briefOut;
  const r2 = mgr.start(reviewRequest({ followup_to: r1.job_id }));
  await finish(mgr, r2.job_id);
  const brief = fs.readFileSync(briefOut, 'utf8');
  assert.match(brief, /- r1\.f1: Retry storm risk\n {2}grounds: The excerpt retries without a cap\./);
  assert.match(brief, /- r1\.u1: Current QPS/);
  assert.match(brief, /- r1\.c1: Load test -- lead's verdict: confirmed \(Replayed; p99 held\.\)/);
  assert.match(brief, /method: Replay peak traffic/);
  assert.match(brief, /expected signal: p99 under 300ms/);
  assert.match(brief, /QPS below 5.*No cap needed/);
  assert.match(brief, /stance: proceed/);
  delete process.env.STUB_BRIEF_OUT;
  fs.rmSync(briefOut, { force: true });
});

test('follow-ups retain disagreements by round and name omitted unchecked items', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'history-brief-'));
  const briefOut = path.join(dir, 'brief.txt');
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_ANSWER_PATCH = JSON.stringify({
    remaining_disagreements: [{ topic: 'Cap size', your_position: 'Use 3', why_unresolved: 'Peak load unknown' }],
    next_checks: Array.from({ length: 8 }, (_, i) => ({
      check: `Check ${i + 1}`,
      method: `Replay ${i + 1}`,
      expected_signal: `Signal ${i + 1}`,
    })),
  });
  try {
    const mgr = new JobManager();
    const r1 = mgr.start(reviewRequest());
    await finish(mgr, r1.job_id);
    mgr.record({
      job_id: r1.job_id,
      entries: [
        ...Array.from({ length: 7 }, (_, i) => ({ id: `c${i + 1}`, verdict: 'unverified', note: 'Not checked' })),
        { id: 'c8', verdict: 'confirmed', effect: 'Eighth check holds' },
      ],
    });
    delete process.env.STUB_ANSWER_PATCH;
    process.env.STUB_BRIEF_OUT = briefOut;
    const r2 = mgr.start({ followup_to: r1.job_id, question: 'Recheck the cap with this evidence.' });
    await finish(mgr, r2.job_id);
    const r3 = mgr.start({ followup_to: r2.job_id, question: 'What remains unresolved?' });
    await finish(mgr, r3.job_id);
    const brief = fs.readFileSync(briefOut, 'utf8');
    assert.match(brief, /### Round 1[\s\S]*Cap size[\s\S]*Use 3[\s\S]*Peak load unknown/);
    assert.match(brief, /r1\.c8: Check 8 -- lead's verdict: confirmed \(Eighth check holds\)[\s\S]*Replay 8[\s\S]*Signal 8/);
    assert.match(brief, /2 .*omitted/i);
    assert.match(brief, /### Round 2/);
  } finally {
    delete process.env.STUB_ANSWER_PATCH;
    delete process.env.STUB_BRIEF_OUT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized latest history round stays within budget and keeps checked evidence first', async () => {
  const { renderBrief } = await import('../src/brief.mjs');
  const { parseRequest } = await import('../src/schema.mjs');
  const prior = {
    round: 1,
    mode: 'review',
    question: 'Q',
    summary: 'S',
    findings: Array.from({ length: 60 }, (_, i) => ({
      id: `f${i + 1}`,
      point: 'p'.repeat(400),
      grounds: 'g'.repeat(400),
      verdict: 'unverified',
      effect: 'e'.repeat(400),
    })),
    next_checks: [
      {
        id: 'c1',
        point: 'Critical check' + 'p'.repeat(380),
        method: 'Replay peak' + 'm'.repeat(380),
        expected_signal: 'No overload' + 's'.repeat(380),
        verdict: 'confirmed',
        effect: 'Verified locally' + 'e'.repeat(380),
      },
    ],
  };
  const brief = renderBrief(parseRequest(reviewRequest()), { round: 2, priorRounds: [prior] });
  const history = brief.slice(brief.indexOf('### Round 1'), brief.indexOf('This round is a follow-up'));
  assert.ok(history.length <= 40_000, `${history.length} exceeds history budget`);
  assert.match(history, /r1\.c1: Critical check.*confirmed/);
  assert.match(history, /Replay peak/);
  assert.match(history, /omitted/i);
});

test('earlier rounds past their budget are left out oldest first, and the brief says so', async () => {
  const { renderBrief } = await import('../src/brief.mjs');
  const { parseRequest } = await import('../src/schema.mjs');
  const round = (n) => ({
    round: n,
    mode: 'review',
    question: `question ${n}`,
    summary: `summary ${n} ${'x'.repeat(7_900)}`,
    findings: Array.from({ length: 30 }, (_, i) => ({
      id: `f${i + 1}`,
      point: 'p'.repeat(400),
      grounds: 'g'.repeat(400),
      verdict: 'confirmed',
      effect: null,
    })),
    unknowns: [],
    next_checks: [],
  });
  const brief = renderBrief(parseRequest(reviewRequest()), { round: 5, priorRounds: [1, 2, 3, 4].map(round) });
  assert.match(brief, /Rounds 1, 2, 3 left out/);
  assert.match(brief, /### Round 4 /);
  assert.doesNotMatch(brief, /### Round 1 /);
});

test('history at the multi-round budget boundary includes its trailing separators', async () => {
  const { renderBrief } = await import('../src/brief.mjs');
  const { parseRequest } = await import('../src/schema.mjs');
  const rounds = [7_580, 8_000, 8_000, 8_000].map((size, i) => ({
    round: i + 1,
    mode: 'review',
    question: 'q'.repeat(1_200),
    summary: 's'.repeat(size),
    findings: [{ id: 'f1', point: 'p'.repeat(400), grounds: 'g'.repeat(400) }],
  }));
  const brief = renderBrief(parseRequest(reviewRequest()), { round: 5, priorRounds: rounds });
  const history = brief.slice(brief.indexOf('### Round'), brief.indexOf('This round is a follow-up'));
  assert.ok(history.length <= 40_000, `${history.length} exceeds history budget`);
});

test("a follow-up that leaves out the mode keeps its chain's", async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const { mode: _, ...first } = exploreRequest({ target: 'codex' });
  const r1 = mgr.start(first);
  assert.equal(r1.mode, 'explore');
  await finish(mgr, r1.job_id);
  // A proposal alone would read as review; the chain stays explore.
  const { mode: __, ...next } = reviewRequest({ followup_to: r1.job_id });
  const r2 = mgr.start(next);
  assert.equal(r2.mode, 'explore');
  await finish(mgr, r2.job_id);
});

test('a consultation that hands over no file says so, and one that does counts them', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const bare = mgr.start(reviewRequest());
  assert.equal(bare.files_exposed, 0);
  assert.match(bare.files_note, /expose_paths/);
  await finish(mgr, bare.job_id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-files-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'x');
  fs.writeFileSync(path.join(dir, 'b.mjs'), 'y');
  const req = reviewRequest();
  const exposed = mgr.start({ ...req, context: { ...req.context, expose_paths: [dir] } });
  assert.equal(exposed.files_exposed, 2);
  assert.equal('files_note' in exposed, false);
  await finish(mgr, exposed.job_id);
});

test('a verdict written by one server keeps the verdicts and reflection another wrote', async () => {
  const briefOut = path.join(os.tmpdir(), `pc-brief5-${Date.now()}.txt`);
  process.env.STUB_BEHAVIOR = 'ok';
  const a = new JobManager();
  const r1 = a.start(reviewRequest());
  await finish(a, r1.job_id);
  // A still holds the job in memory while another server records on disk.
  const b = new JobManager();
  b.record({
    job_id: r1.job_id,
    entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Reproduced the storm.' }],
    reflection: { delta: 'The cap was new to me.' },
  });
  a.record({ job_id: r1.job_id, entries: [{ id: 'c1', verdict: 'unverifiable', effect: 'No staging load.' }] });

  for (const view of [a.view(r1.job_id), new JobManager().view(r1.job_id)]) {
    assert.deepEqual(
      view.record.entries.map((e) => [e.id, e.verdict]),
      [
        ['f1', 'confirmed'],
        ['c1', 'unverifiable'],
      ],
    );
    assert.equal(view.reflection.delta, 'The cap was new to me.');
  }
  process.env.STUB_BRIEF_OUT = briefOut;
  const r2 = a.start(reviewRequest({ followup_to: r1.job_id }));
  await finish(a, r2.job_id);
  const brief = fs.readFileSync(briefOut, 'utf8');
  assert.match(brief, /r1\.f1: .*lead's verdict: confirmed \(Reproduced the storm\.\)/);
  assert.match(brief, /r1\.c1: .*lead's verdict: unverifiable \(No staging load\.\)/);
  delete process.env.STUB_BRIEF_OUT;
  fs.rmSync(briefOut, { force: true });
});

test('a follow-up survives a server restart and tells the consultant how its points were checked', async () => {
  const briefOut = path.join(os.tmpdir(), `pc-brief3-${Date.now()}.txt`);
  process.env.STUB_BEHAVIOR = 'ok';
  const before = new JobManager();
  const r1 = before.start(reviewRequest());
  await finish(before, r1.job_id);
  const f = before.view(r1.job_id).result.findings[0];
  before.record({
    job_id: r1.job_id,
    entries: [{ id: f.id, verdict: 'not_applicable', effect: 'The client already caps retries at 2.' }],
  });

  // A new manager has nothing in memory: the parent and its verdict come from the history.
  const after = new JobManager();
  process.env.STUB_BRIEF_OUT = briefOut;
  const r2 = after.start(reviewRequest({ followup_to: r1.job_id }));
  await finish(after, r2.job_id);
  assert.equal(after.view(r2.job_id).round, 2);
  assert.equal(after.view(r2.job_id).chain_id, r1.chain_id);
  const brief = fs.readFileSync(briefOut, 'utf8');
  assert.match(brief, /Earlier rounds of this same consultation/);
  assert.match(brief, new RegExp(`${f.id}: .*lead's verdict: not_applicable \\(The client already caps retries at 2\\.\\)`));
  delete process.env.STUB_BRIEF_OUT;
  fs.rmSync(briefOut, { force: true });
});

test('only the latest round can be followed up, and a failed later round does not block a retry', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const r1 = mgr.start(reviewRequest());
  await finish(mgr, r1.job_id);
  const r2 = mgr.start(reviewRequest({ followup_to: r1.job_id }));
  await finish(mgr, r2.job_id);
  // Read back after a restart too: round 2 lives in the history only.
  assert.throws(
    () => new JobManager().start(reviewRequest({ followup_to: r1.job_id })),
    (e) => e.code === 'followup_not_latest' && e.message.includes(r2.job_id),
  );

  process.env.STUB_BEHAVIOR = 'usage_limit';
  const r3 = mgr.start(reviewRequest({ followup_to: r2.job_id }));
  await finish(mgr, r3.job_id);
  process.env.STUB_BEHAVIOR = 'ok';
  const r4 = mgr.start(reviewRequest({ followup_to: r2.job_id }));
  await finish(mgr, r4.job_id);
  assert.equal(mgr.view(r4.job_id).round, 4, 'numbered after the failed round, so no history file is overwritten');
});

test('follow-up to an unfinished or unknown job is refused', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.SEVERALLY_TIMEOUT_MS = '1200';
  const { JobManager: M } = await import(`../src/jobs.mjs?fu=${Date.now()}`);
  const mgr = new M();
  const r1 = mgr.start(reviewRequest());
  assert.throws(
    () => mgr.start(reviewRequest({ followup_to: r1.job_id })),
    (e) => e.code === 'followup_not_completed',
  );
  assert.throws(
    () => mgr.start(reviewRequest({ followup_to: 'job_nope' })),
    (e) => e.code === 'unknown_job',
  );
  mgr.cancel(r1.job_id);
  await finish(mgr, r1.job_id);
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
});

test('concurrency is capped server-side', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.SEVERALLY_TIMEOUT_MS = '1200';
  const { JobManager: M } = await import(`../src/jobs.mjs?cc=${Date.now()}`);
  const mgr = new M();
  const started = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => mgr.start(reviewRequest()));
  assert.throws(
    () => mgr.start(reviewRequest()),
    (e) => e.code === 'concurrency_limit',
  );
  mgr.shutdown();
  await Promise.all(started.map((s) => finish(mgr, s.job_id)));
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
});

test('a consultation cannot be started from inside a consultant session', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  process.env.SEVERALLY_ACTIVE = '1';
  try {
    assert.throws(
      () => mgr.start(reviewRequest()),
      (e) => e.code === 'recursion_blocked',
    );
  } finally {
    delete process.env.SEVERALLY_ACTIVE;
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
  assert.throws(
    () => assertNoForbiddenFlags('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox']),
    /permission-widening/,
  );
  assert.throws(() => assertNoForbiddenFlags('claude-code', ['-p', '--dangerously-skip-permissions']), /permission-widening/);
  // --add-dir is accepted in exactly one shape: Claude Code, once, with `/`.
  assert.equal(assertNoForbiddenFlags('claude-code', ['-p', '--add-dir', '/']), true);
  assert.throws(() => assertNoForbiddenFlags('claude-code', ['-p', '--add-dir', '/home']), /widen consultant file access/);
  assert.throws(
    () => assertNoForbiddenFlags('claude-code', ['-p', '--add-dir', '/', '--add-dir', '/tmp']),
    /widen consultant file access/,
  );
  assert.throws(() => assertNoForbiddenFlags('codex', ['exec', '--add-dir', '/']), /permission-widening/);
  assert.throws(() => assertNoForbiddenFlags('antigravity', ['--add-dir', '/']), /permission-widening/);
  assert.throws(() => assertNoForbiddenFlags('opencode', ['run', '--auto']), /permission-widening/);
  assert.throws(() => assertNoForbiddenFlags('opencode', ['run', '--attach', 'http://localhost:4096']), /permission-widening/);
  assert.equal(assertNoForbiddenFlags('opencode', ['run', '--format', 'json', '--pure']), true);
});

test('antigravity consultation: alias target, structured answer, usage recorded', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(antigravityRequest());
  assert.equal(started.target, 'antigravity', 'the alias "gemini" must be normalised');
  assert.equal(started.model, consultantByName('antigravity').model);

  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.match(view.result.summary, /Stub antigravity summary/);
  assert.equal(view.usage.input_tokens, 5722);
  assert.equal(view.usage.thinking_tokens, 23);
  assert.equal(view.usage.cost_usd, null);
});

test('an answer whose consultant read none of the exposed files says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-unread-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'x');
  const req = antigravityRequest();
  const mgr = new JobManager();
  process.env.STUB_BEHAVIOR = 'read_refused';
  const refused = await finish(mgr, mgr.start({ ...req, context: { ...req.context, expose_paths: [dir] } }).job_id);
  assert.equal(refused.status, 'completed');
  assert.match(refused.quality.caveat, /files were exposed, but no call to read one succeeded \(1 failed or were refused\)/);
  assert.doesNotMatch(refused.quality.caveat, /does not allow/, 'read_file is allowed');
  process.env.STUB_BEHAVIOR = 'unknown_tool';
  const renamed = await finish(mgr, mgr.start({ ...req, context: { ...req.context, expose_paths: [dir] } }).job_id);
  assert.match(renamed.quality.caveat, /none was made/);
  assert.match(renamed.quality.caveat, /called open_file, which severally does not allow/);
  assert.doesNotMatch(renamed.quality.caveat, /run_command/, 'a tool refused on purpose is not reported as renamed');
  process.env.STUB_BEHAVIOR = 'ok';
  const bare = await finish(mgr, mgr.start(req).job_id);
  assert.doesNotMatch(bare.quality.caveat ?? '', /files were exposed|does not allow/);
});

test('a Codex answer given without running a single command on the exposed files says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-unread-codex-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'x');
  const req = reviewRequest({ context: { ...reviewRequest().context, expose_paths: [dir] } });
  const mgr = new JobManager();
  process.env.STUB_BEHAVIOR = 'no_commands';
  const silent = await finish(mgr, mgr.start(req).job_id);
  assert.match(silent.quality.caveat, /files were exposed, but no call to read one succeeded \(none was made\)/);
  process.env.STUB_BEHAVIOR = 'failed_command';
  const failed = await finish(mgr, mgr.start(req).job_id);
  assert.doesNotMatch(failed.quality.caveat ?? '', /files were exposed/, 'a command that exits non-zero still looked');
  process.env.STUB_BEHAVIOR = 'ok';
  const looked = await finish(mgr, mgr.start(req).job_id);
  assert.doesNotMatch(looked.quality.caveat ?? '', /files were exposed/);
});

test('a Codex consultation keeps the commands it ran, and how many of the handed-over files they name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-inputs-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'x');
  fs.writeFileSync(path.join(dir, 'b.mjs'), 'y');
  const mgr = new JobManager();
  process.env.STUB_BEHAVIOR = 'failed_command';
  const one = await finish(
    mgr,
    mgr.start(
      reviewRequest({
        context: { ...reviewRequest().context, expose_paths: [path.join(dir, 'a.mjs'), path.join(dir, 'b.mjs')] },
      }),
    ).job_id,
  );
  assert.deepEqual(
    one.tool_inputs.entries,
    ['cat workspace/0-a.mjs'],
    'one entry for the two events of one command, without the shell wrapper',
  );
  assert.equal(one.tool_inputs.exposed_files, 2);
  assert.equal(one.tool_inputs.exposed_mentioned, 1);
  assert.doesNotMatch(JSON.stringify(one), /SECRET FILE BODY/, 'the command output is never kept');
  process.env.STUB_BEHAVIOR = 'ok';
});

test('antigravity: the synthesised home is handed over as HOME and removed afterwards', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const envOut = path.join(home, 'agy-env.json');
  process.env.STUB_ENV_OUT = envOut;
  const mgr = new JobManager();
  const started = mgr.start(antigravityRequest());
  await finish(mgr, started.job_id);
  delete process.env.STUB_ENV_OUT;

  const childEnvSeen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
  assert.notEqual(childEnvSeen.HOME, os.homedir(), 'the consultant must not run with the real HOME');
  assert.match(childEnvSeen.HOME, /homes[\\/]job_[0-9a-f]+$/);
  assert.equal(fs.existsSync(childEnvSeen.HOME), false, 'the sandbox must be gone once the job finished');
});

test('antigravity: an agy that answered but did not exit is stopped, and the answer is kept with its log', async () => {
  process.env.STUB_BEHAVIOR = 'linger';
  process.env.SEVERALLY_AGY_AFTER_RESULT_MS = '300';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(antigravityRequest()).job_id);
  delete process.env.SEVERALLY_AGY_AFTER_RESULT_MS;
  assert.equal(view.status, 'completed');
  assert.match(view.result.summary, /Stub antigravity summary/);
  const { loadRound } = await import('../src/store.mjs');
  const kept = fs.readFileSync(loadRound(view.job_id).diagnostics, 'utf8');
  assert.match(kept, /stub agy log/, "agy's own log is kept although its HOME is removed");
  // Windows has no SIGQUIT: the process tree is ended with taskkill, so no dump.
  if (process.platform !== 'win32') assert.match(kept, /goroutine 1 \[select\]/, 'the SIGQUIT dump is kept');
  assert.doesNotMatch(kept, /sk-ant-api03-AAAA/, 'what is kept is redacted');
});

test('antigravity: a finish step with no result and no exit fails as such instead of running out the budget', async () => {
  process.env.STUB_BEHAVIOR = 'finish_no_result';
  process.env.SEVERALLY_AGY_AFTER_FINISH_MS = '300';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(antigravityRequest()).job_id);
  delete process.env.SEVERALLY_AGY_AFTER_FINISH_MS;
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'cli_error');
  assert.match(view.failure.message, /finish step but neither returned a result nor exited/);
  assert.equal(view.retries.length, 0, 'not re-run: it may have spent its quota already');
  const { loadRound } = await import('../src/store.mjs');
  assert.match(
    fs.readFileSync(loadRound(view.job_id).diagnostics, 'utf8'),
    process.platform === 'win32' ? /stub agy log/ : /goroutine 1/,
  );
});

test("antigravity: a consultation the lead cancels keeps agy's log too", async () => {
  process.env.STUB_BEHAVIOR = 'finish_no_result';
  const mgr = new JobManager();
  const started = mgr.start(antigravityRequest());
  await waitFor(() => /finish/.test(mgr.jobs.get(started.job_id)._handle?.stdoutSoFar() ?? ''));
  mgr.cancel(started.job_id);
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'cancelled');
  const { loadRound } = await import('../src/store.mjs');
  assert.match(
    fs.readFileSync(loadRound(view.job_id).diagnostics, 'utf8'),
    process.platform === 'win32' ? /stub agy log/ : /goroutine 1/,
  );
});

test('antigravity: an ERROR envelope becomes a classified failure, not advice', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(antigravityRequest());
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'usage_limit');
  assert.equal(view.result, null);
  process.env.STUB_BEHAVIOR = 'ok';
});

test('opencode consultation: alias target, last text part wins, usage recorded', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(opencodeRequest());
  assert.equal(started.target, 'opencode', 'the alias "glm" must be normalised');
  assert.equal(started.model, consultantByName('opencode').model);

  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.match(view.result.summary, /Stub opencode summary/);
  assert.equal(view.usage.input_tokens, 10);
  assert.equal(view.usage.cached_input_tokens, 7);
  assert.equal(view.usage.output_tokens, 3);
  assert.equal(view.usage.total_tokens, 21);
  assert.equal(view.usage.reasoning_tokens, 1);
  assert.equal(view.usage.cost_usd, 0.02);
});

test('opencode: an epilogue after the contract falls back to the earlier part', async () => {
  process.env.STUB_BEHAVIOR = 'answer_then_epilogue';
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
    assert.equal(view.status, 'completed', 'the epilogue must not void the answer that preceded it');
    assert.match(view.result.summary, /Stub opencode summary/);
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
  }
});

// Tool results ride inside the event stream; a few large reads used to fill
// the stdout capture and cut off the final answer (invalid_output).
test('opencode: large tool results do not crowd the answer out of the capture', async () => {
  process.env.STUB_BEHAVIOR = 'big_reads';
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
    assert.equal(view.status, 'completed', view.failure?.message?.slice(0, 200));
    assert.match(view.result.summary, /Stub opencode summary/);
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
  }
});

// opencode 2.x reads credentials from the session database, not auth.json,
// so a sandbox that only copies auth.json fails its first run with a
// no-route error -- having created the database schema on the way down.
// severally seeds the credential row into that database and retries once.
test('opencode: a 2.x no-route failure is seeded from auth.json and retried once', { skip: !sqlite }, async () => {
  process.env.STUB_BEHAVIOR = 'no_route_then_ok';
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
    assert.equal(view.status, 'completed', 'the seeded retry must produce the answer');
    assert.match(view.result.summary, /Stub opencode summary/);
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
  }
});

// The recovery may never extend the job's wall-clock budget: when the failed
// first attempt leaves less than the minimum retry window, no respawn
// happens and the job keeps its original classified failure.
test('opencode: the recovery respawn never extends the budget', async () => {
  process.env.STUB_BEHAVIOR = 'no_route_after_delay';
  process.env.SEVERALLY_TIMEOUT_MS = '6000';
  process.env.STUB_DELAY_MS = '2500';
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.failure.kind, 'model_unavailable', 'the original failure stands; no late respawn');
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
    delete process.env.STUB_DELAY_MS;
    process.env.SEVERALLY_TIMEOUT_MS = '20000';
  }
});

// duration_ms and finished_at must describe the job as a whole: a respawned
// consultation that succeeds reports the total time of both attempts plus
// the seeding, not the timestamp of the first failure.
test('opencode: a job that needed its retry reports the full duration', { skip: !sqlite }, async () => {
  process.env.STUB_BEHAVIOR = 'no_route_after_delay';
  process.env.STUB_DELAY_MS = '2500';
  process.env.STUB_RETRY_DELAY_MS = '2000';
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
    assert.equal(view.status, 'completed');
    assert.ok(view.duration_ms >= 4000, `duration must cover both attempts (first ~2.5s + retry ~2s), got ${view.duration_ms}`);
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
    delete process.env.STUB_DELAY_MS;
    delete process.env.STUB_RETRY_DELAY_MS;
  }
});

// The capability probe runs inside the job's accounting: its latency is part
// of the consultation, not free time before the clock starts.
test('opencode: the capability probe counts into the job duration', async () => {
  const { resetProbe } = await import('../src/adapters/opencode.mjs');
  process.env.STUB_HELP = 'standalone';
  process.env.STUB_HELP_DELAY_MS = '1500';
  try {
    await resetProbe();
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
    assert.equal(view.status, 'completed');
    assert.ok(view.duration_ms >= 1500, `probe latency must be inside duration_ms, got ${view.duration_ms}`);
  } finally {
    delete process.env.STUB_HELP;
    delete process.env.STUB_HELP_DELAY_MS;
    await resetProbe();
  }
});

test('opencode: the synthesised home is handed over as HOME and removed afterwards', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const envOut = path.join(home, 'oc-env.json');
  process.env.STUB_ENV_OUT = envOut;
  const mgr = new JobManager();
  const started = mgr.start(opencodeRequest());
  await finish(mgr, started.job_id);
  delete process.env.STUB_ENV_OUT;

  const childEnvSeen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
  assert.notEqual(childEnvSeen.HOME, os.homedir(), 'the consultant must not run with the real HOME');
  assert.match(childEnvSeen.HOME, /homes[\\/]job_[0-9a-f]+$/);
  assert.equal(fs.existsSync(childEnvSeen.HOME), false, 'the sandbox must be gone once the job finished');
  assert.match(childEnvSeen.XDG_DATA_HOME, /^\/|^[A-Za-z]:[\\/]/, 'the XDG data dir must be redirected with HOME');
  assert.ok(
    childEnvSeen.XDG_DATA_HOME.startsWith(childEnvSeen.HOME),
    'the session store must live inside the sandbox, so the brief never reaches the real one',
  );
});

test('opencode: an error-only stream becomes a classified failure, not advice', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const started = mgr.start(opencodeRequest());
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'usage_limit');
  assert.equal(view.result, null);
  process.env.STUB_BEHAVIOR = 'ok';
});

// The synthesised HOME is the only thing isolating the OpenCode consultant,
// and whatever the hosting session exported under OPENCODE_ (OPENCODE_CONFIG,
// OPENCODE_CONFIG_CONTENT, OPENCODE_PERMISSION...) could override the
// sandbox's config outright -- so none of it may reach the child.
test('the OpenCode consultant gets no config-redirecting variable', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const envOut = path.join(home, 'oc-narrow-env.json');
  process.env.STUB_ENV_OUT = envOut;
  const staged = {
    OPENCODE_CONFIG: '/tmp/some-other-opencode.json',
    OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"allow"}}',
    OPENCODE_PERMISSION: '{"edit":"allow"}',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-cross',
  };
  const saved = Object.fromEntries(Object.keys(staged).map((k) => [k, process.env[k]]));
  Object.assign(process.env, staged);
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(opencodeRequest()).job_id);
    assert.equal(view.status, 'completed');
    const seen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION']) {
      assert.equal(seen[key], undefined, `${key} must not survive into the consultant`);
    }
    assert.equal(seen.ANTHROPIC_API_KEY, undefined, "another vendor's key must not cross");
    assert.equal(seen.OPENCODE_DISABLE_AUTOUPDATE, '1', 'the sandbox belt-and-braces still lands');
  } finally {
    delete process.env.STUB_ENV_OUT;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// One key per prefix TARGET_DROP_PREFIX is meant to strip. The claude-code row
// is the longest of the three and used to have no test at all, so a typo in it
// would have leaked an OpenAI or Gemini key into the Claude consultant with
// nothing to catch it.
const VENDOR_KEYS = {
  openai: { OPENAI_API_KEY: 'sk-oai-should-not-cross', CODEX_API_KEY: 'codex-should-not-cross' },
  anthropic: {
    ANTHROPIC_API_KEY: 'sk-ant-should-not-cross',
    ANTHROPIC_AUTH_TOKEN: 'ant-token-should-not-cross',
  },
  google: { GEMINI_API_KEY: 'g-should-not-cross', GOOGLE_API_KEY: 'goog-should-not-cross' },
  zai: { ZAI_API_KEY: 'zai-should-not-cross', ZAI_CODING_PLAN_KEY: 'zai-plan-should-not-cross' },
};

test('each consultant runs with its own vendor credentials and none of the others', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const envOut = path.join(home, 'vendor-env.json');
  process.env.STUB_ENV_OUT = envOut;
  for (const keys of Object.values(VENDOR_KEYS)) Object.assign(process.env, keys);

  const cases = [
    { target: 'codex', request: reviewRequest(), own: 'openai' },
    { target: 'claude-code', request: exploreRequest(), own: 'anthropic' },
    { target: 'antigravity', request: antigravityRequest(), own: 'google' },
    { target: 'opencode', request: opencodeRequest(), own: 'zai' },
  ];

  try {
    const mgr = new JobManager();
    for (const c of cases) {
      const view = await finish(mgr, mgr.start(c.request).job_id);
      assert.equal(view.status, 'completed', `${c.target} consultation must have run`);
      assert.equal(view.target, c.target);
      const seen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
      for (const [vendor, keys] of Object.entries(VENDOR_KEYS)) {
        for (const [key, value] of Object.entries(keys)) {
          if (vendor === c.own) {
            assert.equal(seen[key], value, `${c.target} must keep its own ${key}`);
          } else {
            assert.equal(seen[key], undefined, `${c.target} must never see ${key}`);
          }
        }
      }
    }
  } finally {
    delete process.env.STUB_ENV_OUT;
    for (const keys of Object.values(VENDOR_KEYS)) for (const key of Object.keys(keys)) delete process.env[key];
  }
});

// The synthesised HOME is the only thing isolating the Antigravity
// consultant, so nothing that could redirect agy at another config tree may
// reach it -- while the credential prefixes it authenticates with must.
test('the Antigravity consultant gets no config-redirecting variable', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const envOut = path.join(home, 'agy-narrow-env.json');
  process.env.STUB_ENV_OUT = envOut;
  // Restore whatever the host had, rather than deleting: these are real
  // variables a developer may well have set for their own agy or gcloud.
  const staged = {
    XDG_CONFIG_HOME: '/tmp/some-other-config',
    AGY_CLI_HIDE_LOGO: '1',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: '/tmp/some-other-data',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
  };
  const saved = Object.fromEntries(Object.keys(staged).map((k) => [k, process.env[k]]));
  Object.assign(process.env, staged);
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(antigravityRequest()).job_id);
    assert.equal(view.status, 'completed');
    const seen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    assert.equal(seen.XDG_CONFIG_HOME, undefined, 'a redirected config dir must not survive');
    assert.equal(seen.AGY_CLI_HIDE_LOGO, undefined);
    assert.equal(seen.ANTIGRAVITY_EXECUTABLE_DATA_DIR, undefined);
    assert.match(seen.HOME, /homes[\\/]job_[0-9a-f]+$/, 'HOME must still be the synthesised one');
    assert.equal(
      seen.GOOGLE_APPLICATION_CREDENTIALS,
      '/tmp/adc.json',
      'an API-key/ADC credential is how some operators authenticate: it must survive',
    );
  } finally {
    delete process.env.STUB_ENV_OUT;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// store.mjs claims everything it writes has been through redact(); the
// question was the one field that had not.
test('a credential pasted into the question never reaches the history file', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ question: `Can we keep using ${secret} in CI?` }));
  const view = await finish(mgr, started.job_id);

  assert.ok(!view.question.includes(secret), 'the recorded question must not carry the token');
  assert.match(view.question, /REDACTED/);
  const record = JSON.parse(fs.readFileSync(path.join(home, 'history', started.chain_id, 'round-01.json'), 'utf8'));
  assert.ok(!record.question.includes(secret), 'the history file must not carry the token');
  assert.match(record.question, /REDACTED/);
});

// The sandbox has always computed credentials: 'missing'; nothing consumed it,
// so an operator whose token is absent -- or under a different
// SEVERALLY_AGY_CRED_HOME -- got whatever generic auth error agy emits,
// with no hint that severally had searched a specific path and found
// nothing to link. Both branches are pinned here, because the token file and
// an API key / ADC file are alternatives: refusing on the absence of the token
// alone would break the API-key operator whose variables run.mjs keeps.
test('a missing Antigravity credential fails the job as auth, before the child starts', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const emptyCredHome = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-nocred-'));
  const prevCredHome = process.env.SEVERALLY_AGY_CRED_HOME;
  const envOut = path.join(home, 'nocred-env.json');
  process.env.SEVERALLY_AGY_CRED_HOME = emptyCredHome;
  process.env.STUB_ENV_OUT = envOut;
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(antigravityRequest()).job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.failure.kind, 'auth');
    assert.equal(view.failure.retriable, false);
    assert.equal(view.result, null);
    assert.ok(view.failure.message.includes(emptyCredHome), 'the failure must name the path that was searched');
    assert.match(view.failure.message, /antigravity-oauth-token/);
    assert.match(view.failure.message, /GOOGLE_API_KEY/, 'the API-key alternative must be named');
    assert.equal(fs.existsSync(envOut), false, 'the consultant must not have been spawned at all');

    // An ADC path that names no file is not a credential: counting it would
    // put back the generic "not logged in" this check exists to replace.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(emptyCredHome, 'not-a-real-adc.json');
    const stale = await finish(mgr, mgr.start(antigravityRequest()).job_id);
    assert.equal(stale.status, 'failed', 'a path to nothing must not count as a credential');
    assert.equal(stale.failure.kind, 'auth');
    assert.equal(fs.existsSync(envOut), false, 'still nothing spawned');
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    // Same missing token file, but an API key is set: this operator was able
    // to consult before the check existed and must still be able to.
    process.env.GOOGLE_API_KEY = 'goog-api-key-only';
    const withKey = await finish(mgr, mgr.start(antigravityRequest()).job_id);
    assert.equal(withKey.status, 'completed', 'an API-key-only operator must not be refused');
    const seen = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    assert.equal(seen.GOOGLE_API_KEY, 'goog-api-key-only', 'the key must reach the consultant');
    delete process.env.GOOGLE_API_KEY;

    // And an ADC file that does exist counts, the same way the token does.
    const adcPath = path.join(emptyCredHome, 'adc.json');
    fs.writeFileSync(adcPath, '{}');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
    const withAdc = await finish(mgr, mgr.start(antigravityRequest()).job_id);
    assert.equal(withAdc.status, 'completed', 'an existing ADC file must not be refused');
  } finally {
    delete process.env.STUB_ENV_OUT;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.SEVERALLY_AGY_CRED_HOME = prevCredHome;
  }
});

// The model a request names has to reach the CLI's argv, not just the job
// record -- otherwise the consultation runs on the default and only *claims*
// to have used what was asked for.
test('a second consultant on the same CLI is launched with its own model', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const argvOut = path.join(home, 'model-argv.json');
  process.env.STUB_ARGV_OUT = argvOut;
  const mgr = new JobManager();

  const started = mgr.start(reviewRequest({ target: 'mini' }));
  assert.equal(started.model, 'gpt-6-astra-mini', 'the accepted model is reported back at start');
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.equal(view.model, 'gpt-6-astra-mini', 'the job records the model that actually ran');

  const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6-astra-mini', 'codex was launched with the named model');

  delete process.env.STUB_ARGV_OUT;
});

// A bare "it timed out" says nothing about whether the consultant was working
// or wedged, which is the difference between raising the budget and narrowing
// the brief. The adapters that stream their events can say which it was.
test('a timeout reports how far the consultant got', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.SEVERALLY_TIMEOUT_MS = '1200';
  const { JobManager: M } = await import(`../src/jobs.mjs?progress=${Date.now()}`);
  const mgr = new M();

  const started = mgr.start(reviewRequest());
  const view = await finish(mgr, started.job_id);

  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'timeout');
  assert.equal(view.failure.retriable, true);
  assert.match(
    view.failure.detail ?? '',
    /still working when the budget ran out/,
    'the trail the consultant left before it was killed',
  );

  process.env.SEVERALLY_TIMEOUT_MS = '20000';
  process.env.STUB_BEHAVIOR = 'ok';
});

// "running" for twenty minutes is not a status a lead can act on. The point of
// reading the stream while it runs is that a heavy consultation can be cut
// short instead of waited out.
test('a running consultation reports what it is doing', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.SEVERALLY_TIMEOUT_MS = '5000';
  const { JobManager: M } = await import(`../src/jobs.mjs?live=${Date.now()}`);
  const mgr = new M();
  const started = mgr.start(reviewRequest());

  const seen = await waitFor(
    () => {
      const v = mgr.view(started.job_id);
      return v.status === 'running' && v.progress ? v : null;
    },
    { timeoutMs: 4000, intervalMs: 25 },
  );

  assert.match(seen.progress, /item event\(s\)/, 'the trail, while it is still being made');
  assert.match(seen.progress, /web_search/);

  mgr.cancel(started.job_id);
  await finish(mgr, started.job_id);
  assert.equal(mgr.view(started.job_id).progress, null, 'and nothing to report once it is over');

  process.env.SEVERALLY_TIMEOUT_MS = '20000';
  process.env.STUB_BEHAVIOR = 'ok';
});

test('another manager sees the same persisted running progress without raw event content', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const mgr = new JobManager();
  const observer = new JobManager();
  const started = mgr.start(reviewRequest());
  try {
    const seen = await waitFor(
      () => {
        const view = observer.view(started.job_id);
        return view?.progress_observation?.event_count ? view : null;
      },
      { timeoutMs: 4000, intervalMs: 50 },
    );
    const local = mgr.view(started.job_id);
    assert.deepEqual(local.progress_observation, seen.progress_observation);
    assert.equal(local.progress, seen.progress);
    const moduleUrl = new URL('../src/jobs.mjs', import.meta.url).href;
    const remote = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { JobManager } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(new JobManager().view(${JSON.stringify(started.job_id)}).progress_observation));`,
        ],
        { encoding: 'utf8', env: process.env },
      ),
    );
    assert.deepEqual(remote, seen.progress_observation);
    assert.equal(seen.progress_observation.phase, 'events_observed');
    assert.equal(seen.progress_observation.attempt, 1);
    assert.ok(seen.progress_observation.deadline_at);
    assert.doesNotMatch(JSON.stringify(seen.progress_observation), /stub-thread|command_execution|SECRET/);
  } finally {
    mgr.cancel(started.job_id);
    await finish(mgr, started.job_id);
    process.env.STUB_BEHAVIOR = 'ok';
  }
});

for (const target of ['opencode', 'antigravity']) {
  test(`${target} running events are visible from another manager`, async () => {
    process.env.STUB_BEHAVIOR = 'hang';
    const mgr = new JobManager();
    const observer = new JobManager();
    const started = mgr.start(reviewRequest({ target }));
    try {
      const seen = await waitFor(
        () => {
          const view = observer.view(started.job_id);
          return view?.progress_observation?.event_count ? view : null;
        },
        { timeoutMs: 5000, intervalMs: 50 },
      );
      assert.equal(seen.progress_observation.phase, 'events_observed');
      assert.equal(mgr.view(started.job_id).progress, seen.progress);
      assert.doesNotMatch(JSON.stringify(seen.progress_observation), /search_web|grep|ses_stub/);
    } finally {
      mgr.cancel(started.job_id);
      await finish(mgr, started.job_id);
      process.env.STUB_BEHAVIOR = 'ok';
    }
  });
}

test('progress observes events after the stdout capture limit', async () => {
  process.env.STUB_BEHAVIOR = 'hang_after_capture_limit';
  const mgr = new JobManager();
  const observer = new JobManager();
  const started = mgr.start(reviewRequest());
  try {
    const seen = await waitFor(
      () => {
        const view = observer.view(started.job_id);
        return view?.progress?.includes('web_search') ? view : null;
      },
      { timeoutMs: 5000, intervalMs: 50 },
    );
    assert.ok(seen.progress_observation.event_count >= 3);
  } finally {
    mgr.cancel(started.job_id);
    await finish(mgr, started.job_id);
    process.env.STUB_BEHAVIOR = 'ok';
  }
});

// The server may report what it can derive -- the consultant's own
// evidence_basis, findings without grounds, whether anything was cited -- and
// must stop short of pronouncing the advice usable, which is a judgement it
// has neither the context nor the standing to make.
test('the delivered result carries no verdict from the server', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest()).job_id);

  assert.equal(view.status, 'completed');
  assert.equal(Object.hasOwn(view.quality, 'advice_usable'), false, 'no "this is usable" stamp');
  assert.equal(view.quality.evidence_basis, 'sufficient', "the consultant's own claim, passed through");
  assert.equal(typeof view.quality.findings_without_grounds, 'number', 'a count, not an opinion');
});

// Opus 5.5 consultant, a lead on another Claude model: same vendor. The caveat
// has to say what that is and is not -- a stronger model of the same lineage
// adds capability and drops the session's drift, but not the lineage's blind
// spots -- and the record has to keep both model names, since nothing else in
// the payload says what the lead was running.
test('a same-vendor consultation on a different model names both models in the caveat and the record', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  // Sonnet and Opus share no run of words that makes one a version of the
  // other: a different model, named as declared and as launched.
  const started = mgr.start(reviewRequest({ target: 'claude-code', caller: 'claude-code', caller_model: 'claude-sonnet-5' }));
  const view = await finish(mgr, started.job_id);
  assert.equal(view.caller_model, 'claude-sonnet-5');
  assert.equal(view.model, 'claude-opus-5-5');
  assert.match(view.quality.caveat, /same vendor/i);
  assert.match(view.quality.caveat, /different model: you declared claude-sonnet-5, it ran claude-opus-5-5/);
  assert.match(view.quality.caveat, /lineage|blind spots/i);
  // A declared name that is part of the launched one ("claude-opus-5" in
  // "claude-opus-5-5") could be either: relay both, assert neither.
  const unsure = await finish(
    mgr,
    mgr.start(reviewRequest({ target: 'claude-code', caller: 'claude-code', caller_model: 'claude-opus-5' })).job_id,
  );
  assert.match(unsure.quality.caveat, /You declared claude-opus-5; it ran claude-opus-5-5/, 'both names, side by side');
  assert.doesNotMatch(unsure.quality.caveat, /different model|and the same model/i, 'the server cannot establish either');
});

test('a same-vendor consultation on the same model says so', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: 'claude-code', caller: 'claude-code', caller_model: 'claude-opus-5-5' }));
  const view = await finish(mgr, started.job_id);
  assert.match(view.quality.caveat, /same model/i);
  assert.doesNotMatch(view.quality.caveat, /different model/i);
});

test('caller_model is recorded on a cross-vendor consultation without adding a caveat', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const view = await finish(mgr, mgr.start(reviewRequest({ caller: 'claude-code', caller_model: 'claude-opus-5' })).job_id);
  assert.equal(view.caller_model, 'claude-opus-5');
  assert.equal(/same vendor/i.test(view.quality.caveat ?? ''), false);
});

// Live check 2026-09-11 (job_519387850a7c, claude-code consultant): the
// consultant's own f1 -- a host reports its model in whatever spelling it has
// ("Claude Opus 5.5"), the consultant side is the operator's config string,
// and plain equality would print a false "different model", which is less
// cautious than saying nothing. Resolve the declared name the way a target
// suffix is resolved; a name the server cannot place is said to be unknown.
test('a same-vendor caveat resolves the declared caller model before comparing', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const spelled = await finish(
    mgr,
    mgr.start(reviewRequest({ target: 'claude-code', caller: 'claude-code', caller_model: 'Claude Opus 5.5' })).job_id,
  );
  assert.match(spelled.quality.caveat, /same model/i, 'a spelling variant of the launched model is the same model');
  assert.doesNotMatch(spelled.quality.caveat, /different model/i);
  // "Opus 5" could be Opus 5.5 written short, or an older Opus: unplaceable.
  const unknown = await finish(
    mgr,
    mgr.start(reviewRequest({ target: 'claude-code', caller: 'claude-code', caller_model: 'Opus 5' })).job_id,
  );
  assert.match(
    unknown.quality.caveat,
    /cannot tell whether those are one model/i,
    'an unplaceable name must not be reported as a different model',
  );
  assert.doesNotMatch(unknown.quality.caveat, /different model/i);
  assert.doesNotMatch(unknown.quality.caveat, /and the same model/i);
  assert.match(unknown.quality.caveat, /Opus 5;/, 'the declaration itself is still relayed');
});

// The point of expose_paths: the consultant is told where a bounded set of
// real files is, instead of being handed excerpts someone pre-selected.
test('exposed paths reach the consultant working directory and are named in the brief', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const briefOut = path.join(home, 'expose-brief.txt');
  const cwdOut = path.join(home, 'expose-cwd.json');
  process.env.STUB_BRIEF_OUT = briefOut;
  process.env.STUB_CWD_OUT = cwdOut;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-repo-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'retry.ts'), 'for (let i=0;i<5;i++) await call();');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo');

  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      context: {
        facts: ['The client retries 5 times.'],
        proposal: 'Add jitter.',
        expose_paths: [path.join(repo, 'src'), path.join(repo, 'README.md')],
      },
    }),
  );
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');

  // What the consultant could actually open, as it saw it.
  const seen = JSON.parse(fs.readFileSync(cwdOut, 'utf8'));
  assert.ok(seen.includes('workspace/0-src/retry.ts'), `exposed file missing from the consultant cwd: ${seen}`);
  assert.ok(seen.includes('workspace/1-README.md'), `exposed file missing from the consultant cwd: ${seen}`);

  const brief = fs.readFileSync(briefOut, 'utf8');
  assert.match(brief, /Files available to you/);
  assert.match(brief, /workspace\/0-src/);
  assert.match(brief, /workspace\/1-README\.md/);
  assert.match(brief, /directory, 1 file\(s\)/);
  // The empty-working-directory rule has to flip, or the consultant is told
  // in one breath that it has files and in the next that it has none.
  assert.doesNotMatch(brief, /You are running in an empty working directory/);
  assert.match(brief, /Your working directory is not empty/);
  assert.match(brief, /read the ones the question turns on before you answer/);

  assert.ok(!fs.existsSync(path.join(home, 'jobs', started.job_id)), 'the copy goes with the job directory');
  delete process.env.STUB_BRIEF_OUT;
  delete process.env.STUB_CWD_OUT;
});

test('the history keeps what was exposed as a manifest, not as content', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-repo-'));
  fs.writeFileSync(path.join(repo, 'secret-plan.md'), 'the whole plan, in full');

  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      context: { facts: ['f'], proposal: 'p', expose_paths: [path.join(repo, 'secret-plan.md')] },
    }),
  );
  await finish(mgr, started.job_id);

  const record = JSON.parse(fs.readFileSync(path.join(home, 'history', started.chain_id, 'round-01.json'), 'utf8'));
  const exposed = record.brief.expose_paths;
  assert.equal(exposed.entries.length, 1);
  assert.equal(exposed.entries[0].exposed_as, 'workspace/0-secret-plan.md');
  assert.equal(exposed.entries[0].kind, 'file');
  assert.equal(exposed.entries[0].files, 1);
  assert.ok(exposed.entries[0].bytes > 0);
  assert.ok(
    !JSON.stringify(record).includes('the whole plan, in full'),
    'the record says what was shown, it does not keep a copy of it',
  );
});

// Nothing should be spent on a request that names a path that is not there:
// no job, no round, no consultant process.
test('a path that does not exist is refused before a job exists', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const missing = path.join(os.tmpdir(), `severally-not-here-${Date.now()}`);
  assert.throws(
    () => mgr.start(reviewRequest({ context: { facts: ['f'], proposal: 'p', expose_paths: [missing] } })),
    (err) => err.code === 'expose_path_invalid' && err.message.includes(missing),
  );
  assert.equal(mgr.list().filter((j) => j.this_session).length, 0, 'no job may have been created');
});

test('a tree over the size cap is refused before a job exists', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-big-'));
  fs.writeFileSync(path.join(repo, 'huge.bin'), Buffer.alloc(6_000_000, 3));
  const mgr = new JobManager();
  assert.throws(
    () => mgr.start(reviewRequest({ context: { facts: ['f'], proposal: 'p', expose_paths: [repo] } })),
    (err) => err.code === 'expose_paths_too_large',
  );
  assert.equal(mgr.list().filter((j) => j.this_session).length, 0);
});

// A consultation with no exposed paths must read exactly as it did before.
test('a consultation that exposes nothing still says the working directory is empty', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const briefOut = path.join(home, 'no-expose-brief.txt');
  process.env.STUB_BRIEF_OUT = briefOut;
  const mgr = new JobManager();
  await finish(mgr, mgr.start(reviewRequest()).job_id);
  const brief = fs.readFileSync(briefOut, 'utf8');
  assert.match(brief, /You are running in an empty working directory/);
  assert.doesNotMatch(brief, /Files available to you/);
  delete process.env.STUB_BRIEF_OUT;
});

// --add-dir / exists so the three consultants read the same amount of an
// empty directory. Once the lead has drawn a scope, widening to the whole
// disk contradicts it -- and this is the one consultant whose read scope can
// actually be enforced rather than merely undisclosed.
test('the Claude Code consultant loses its whole-disk read scope once paths are exposed', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const argvOut = path.join(home, 'expose-argv.json');
  process.env.STUB_ARGV_OUT = argvOut;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-repo-'));
  fs.writeFileSync(path.join(repo, 'index.mjs'), 'export const x = 1;');
  const mgr = new JobManager();

  await finish(mgr, mgr.start(exploreRequest()).job_id);
  const wide = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  assert.deepEqual(
    wide.flatMap((a, i) => (a === '--add-dir' ? [wide[i + 1]] : [])),
    ['/'],
  );

  await finish(
    mgr,
    mgr.start(
      exploreRequest({
        context: { facts: ['f'], expose_paths: [path.join(repo, 'index.mjs')] },
      }),
    ).job_id,
  );
  const scoped = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  assert.ok(!scoped.includes('--add-dir'), 'a scoped consultation must not widen to the whole disk');
  // Everything else about the consultant is unchanged.
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
    assert.ok(scoped.includes(flag), `${flag} must survive`);
  }
  assert.deepEqual(scoped[scoped.indexOf('--tools') + 1].split(','), ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);

  delete process.env.STUB_ARGV_OUT;
});

test('a follow-up needs only followup_to and the question: target, premises and proposal come from the round before', async () => {
  const briefOut = path.join(os.tmpdir(), `pc-brief-inherit-${Date.now()}.txt`);
  process.env.STUB_BEHAVIOR = 'ok';
  for (const first of [reviewRequest(), debateRequest()]) {
    const mgr = new JobManager();
    const r1 = mgr.start(first);
    await finish(mgr, r1.job_id);
    let parent = r1.job_id;
    // Across a restart too: the parent's brief is read back from the history.
    for (const m of [mgr, new JobManager()]) {
      process.env.STUB_BRIEF_OUT = briefOut;
      const r2 = m.start({ followup_to: parent, question: 'What would change your bottom line?' });
      assert.equal(r2.mode, first.mode);
      assert.equal(m.view(r2.job_id).target, 'codex');
      assert.equal((await finish(m, r2.job_id)).status, 'completed');
      const brief = fs.readFileSync(briefOut, 'utf8');
      const current = brief.slice(0, brief.indexOf('Earlier rounds'));
      assert.match(current, /What would change your bottom line\?/);
      assert.ok(current.includes(first.context.proposal), 'the proposal is restated');
      assert.ok(current.includes(first.context.facts[0]), 'the facts are restated');
      for (const c of first.constraints ?? []) assert.ok(current.includes(c));
      for (const c of first.context.counterpoints ?? []) assert.ok(current.includes(c));
      // The next follow-up continues from this round, inheriting what it inherited.
      parent = r2.job_id;
    }
  }
  delete process.env.STUB_BRIEF_OUT;
  fs.rmSync(briefOut, { force: true });
});

test('a field the follow-up passes replaces the earlier one; an explicit empty list stays empty', async () => {
  const briefOut = path.join(os.tmpdir(), `pc-brief-override-${Date.now()}.txt`);
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const r1 = mgr.start(debateRequest());
  await finish(mgr, r1.job_id);
  assert.throws(
    () => mgr.start({ followup_to: r1.job_id, question: 'q', context: { counterpoints: [] } }),
    (e) => e.code === 'counterpoints_required',
  );
  assert.throws(
    () => mgr.start({ followup_to: r1.job_id, question: 'q', target: 'claude-code' }),
    (e) => e.code === 'followup_target_mismatch',
  );
  process.env.STUB_BRIEF_OUT = briefOut;
  const r2 = mgr.start({ followup_to: r1.job_id, question: 'q', context: { proposal: 'Write-behind after all.' } });
  await finish(mgr, r2.job_id);
  const brief = fs.readFileSync(briefOut, 'utf8');
  const current = brief.slice(0, brief.indexOf('Earlier rounds'));
  assert.match(current, /Write-behind after all\./);
  assert.doesNotMatch(current, /Write-through, because/);
  assert.match(current, /Order writes are 200\/s peak\./, 'facts left out are still inherited');
  delete process.env.STUB_BRIEF_OUT;
  fs.rmSync(briefOut, { force: true });
});

// A consultant that finished but left a process holding its output pipes open.
// POSIX only: the grandchild is killed through the process group.
const orphanCase = async (behavior, env = {}) => {
  const pidOut = path.join(os.tmpdir(), `pc-orphan-${process.pid}-${Date.now()}.txt`);
  Object.assign(process.env, { STUB_BEHAVIOR: behavior, STUB_GRANDCHILD_PID_OUT: pidOut, ...env });
  const { JobManager: M } = await import(`../src/jobs.mjs?orphan=${behavior}${Date.now()}`);
  const mgr = new M();
  const t0 = Date.now();
  const started = mgr.start(reviewRequest());
  return {
    mgr,
    started,
    t0,
    pidOut,
    gone: async () => {
      const pid = Number(fs.readFileSync(pidOut, 'utf8'));
      await waitFor(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeoutMs: 8000 },
      );
      delete process.env.STUB_GRANDCHILD_PID_OUT;
      fs.rmSync(pidOut, { force: true });
    },
  };
};

test(
  'a consultant that exits leaving a process on its pipes still closes, its answer kept with a caveat',
  { skip: process.platform === 'win32' },
  async () => {
    for (const behavior of ['orphan_pipe', 'orphan_pipe_stubborn']) {
      const c = await orphanCase(behavior);
      const view = await finish(c.mgr, c.started.job_id);
      assert.ok(Date.now() - c.t0 < 8000, `${behavior} closed in ${Date.now() - c.t0} ms`);
      assert.equal(view.status, 'completed', behavior);
      assert.match(view.quality.caveat, /kept its output open/);
      assert.match(view.quality.caveat, /pipes were closed.*may still be running/i);
      assert.doesNotMatch(view.quality.caveat, /was stopped/i);
      await c.gone();
    }
  },
);

test(
  'a consultant that exits cleanly does not leave a quiet process of its group running',
  { skip: process.platform === 'win32' },
  async () => {
    const c = await orphanCase('orphan_quiet');
    const view = await finish(c.mgr, c.started.job_id);
    assert.equal(view.status, 'completed');
    await c.gone();
  },
);

test(
  'a leftover process with no answer behind it is a cli_error, not advice',
  { skip: process.platform === 'win32' },
  async () => {
    const c = await orphanCase('orphan_pipe_invalid');
    const view = await finish(c.mgr, c.started.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.failure.kind, 'cli_error');
    assert.match(view.failure.message, /pipes were closed.*may still be running/i);
    assert.doesNotMatch(view.failure.message, /was stopped/i);
    await c.gone();
  },
);

test(
  'a deadline or a cancel ends a consultant whose pipes a leftover process holds',
  { skip: process.platform === 'win32' },
  async () => {
    const c = await orphanCase('orphan_pipe_stubborn_hang', { SEVERALLY_TIMEOUT_MS: '1500' });
    const view = await finish(c.mgr, c.started.job_id);
    assert.equal(view.failure.kind, 'timeout');
    await c.gone();
    const d = await orphanCase('orphan_pipe_stubborn_hang', { SEVERALLY_TIMEOUT_MS: '20000' });
    await new Promise((r) => setTimeout(r, 400));
    d.mgr.cancel(d.started.job_id);
    const cancelled = await finish(d.mgr, d.started.job_id);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(Date.now() - d.t0 < 8000);
    await d.gone();
    process.env.SEVERALLY_TIMEOUT_MS = '20000';
  },
);

test('an answer without a bottom line or an evidence basis comes back completed, with a caveat that says so', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  for (const [patch, re] of [
    [{ stance: null }, /no bottom line \(stance\)/],
    [{ stance: 'maybe' }, /no bottom line \(stance\)/],
    [{ evidence_basis: null }, /did not say how well its evidence supports/],
  ]) {
    process.env.STUB_ANSWER_PATCH = JSON.stringify(patch);
    const view = await finish(mgr, mgr.start(reviewRequest()).job_id);
    assert.equal(view.status, 'completed');
    assert.match(view.quality.caveat ?? '', re, JSON.stringify(patch));
  }
  delete process.env.STUB_ANSWER_PATCH;
  const clean = await finish(mgr, mgr.start(reviewRequest()).job_id);
  assert.doesNotMatch(clean.quality.caveat ?? '', /bottom line|evidence supports/);
});

test("a follow-up that leaves out network keeps the earlier round's; a caller's own diff artifact carries over", async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const req = reviewRequest({ network: 'off' });
  req.context = { ...req.context, artifacts: [{ name: 'git diff of the fix', kind: 'diff', excerpt: '+cap retries' }] };
  const r1 = mgr.start(req);
  await finish(mgr, r1.job_id);
  const r2 = mgr.start({ followup_to: r1.job_id, question: 'q' });
  const view = await finish(mgr, r2.job_id);
  assert.equal(view.network, 'off');
  const r3 = mgr.start({ followup_to: r2.job_id, question: 'q', network: 'on' });
  assert.equal((await finish(mgr, r3.job_id)).network, 'on');
  const full = mgr.view(r2.job_id, { detail: 'full' });
  assert.ok(full.brief.artifacts.some((a) => a.name === 'git diff of the fix'));
});

test('a follow-up that passes constraints inside context replaces the earlier ones', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const r1 = mgr.start(reviewRequest());
  await finish(mgr, r1.job_id);
  const r2 = mgr.start({ followup_to: r1.job_id, question: 'q', context: { constraints: ['Only the client may change'] } });
  await finish(mgr, r2.job_id);
  assert.deepEqual(mgr.view(r2.job_id, { detail: 'full' }).brief.constraints, ['Only the client may change']);
});
