import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandboxEnv, reviewRequest, exploreRequest, antigravityRequest, waitFor } from './helpers.mjs';

// A second codex model, so the model-suffix test has something besides the
// default to name. POLICY freezes at first import, so this has to be set here
// rather than inside the test.
const home = sandboxEnv({ PEER_CONSULT_CODEX_ALLOWED_MODELS: 'gpt-6-astra-mini' });
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

test('a same-vendor consultation is delivered with an independence caveat', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest({ target: 'gpt', caller: 'codex' }));
  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.match(view.quality.caveat, /same vendor|independen/i);
  assert.equal(view.caller, 'codex');
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
  assert.ok(codexArgs.includes('shell_environment_policy.inherit="none"'));
  // inherit="none" strips the recursion marker from anything Codex launches
  // from its shell, so it has to be put back explicitly.
  assert.ok(
    codexArgs.includes('shell_environment_policy.set={PEER_CONSULT_ACTIVE="1"}'),
    'the recursion marker must reach the consultant\'s own shell',
  );
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
  const c = mgr.start(reviewRequest());
  assert.throws(() => mgr.start(reviewRequest()), (e) => e.code === 'concurrency_limit');
  mgr.shutdown();
  await Promise.all([finish(mgr, a.job_id), finish(mgr, b.job_id), finish(mgr, c.job_id)]);
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

test('antigravity consultation: alias target, structured answer, usage recorded', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const started = mgr.start(antigravityRequest());
  assert.equal(started.target, 'antigravity', 'the alias "gemini" must be normalised');
  assert.equal(started.model, POLICY.targets.antigravity.model);

  const view = await finish(mgr, started.job_id);
  assert.equal(view.status, 'completed');
  assert.match(view.result.summary, /Stub antigravity summary/);
  assert.equal(view.usage.input_tokens, 5722);
  assert.equal(view.usage.thinking_tokens, 23);
  assert.equal(view.usage.cost_usd, null);
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
  assert.match(childEnvSeen.HOME, /jobs\/.*\/home$/);
  assert.equal(fs.existsSync(childEnvSeen.HOME), false, 'the sandbox must be gone once the job finished');
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
    assert.match(seen.HOME, /jobs\/.*\/home$/, 'HOME must still be the synthesised one');
    assert.equal(
      seen.GOOGLE_APPLICATION_CREDENTIALS, '/tmp/adc.json',
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
  const record = JSON.parse(
    fs.readFileSync(path.join(home, 'history', started.chain_id, 'round-01.json'), 'utf8'),
  );
  assert.ok(!record.question.includes(secret), 'the history file must not carry the token');
  assert.match(record.question, /REDACTED/);
});

// The sandbox has always computed credentials: 'missing'; nothing consumed it,
// so an operator whose token is absent -- or under a different
// PEER_CONSULT_AGY_CRED_HOME -- got whatever generic auth error agy emits,
// with no hint that peer-consult had searched a specific path and found
// nothing to link. Both branches are pinned here, because the token file and
// an API key / ADC file are alternatives: refusing on the absence of the token
// alone would break the API-key operator whose variables run.mjs keeps.
test('a missing Antigravity credential fails the job as auth, before the child starts', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const emptyCredHome = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-nocred-'));
  const prevCredHome = process.env.PEER_CONSULT_AGY_CRED_HOME;
  const envOut = path.join(home, 'nocred-env.json');
  process.env.PEER_CONSULT_AGY_CRED_HOME = emptyCredHome;
  process.env.STUB_ENV_OUT = envOut;
  try {
    const mgr = new JobManager();
    const view = await finish(mgr, mgr.start(antigravityRequest()).job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.failure.kind, 'auth');
    assert.equal(view.failure.retriable, false);
    assert.equal(view.result, null);
    assert.ok(
      view.failure.message.includes(emptyCredHome),
      'the failure must name the path that was searched',
    );
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
    process.env.PEER_CONSULT_AGY_CRED_HOME = prevCredHome;
  }
});

// The model a request names has to reach the CLI's argv, not just the job
// record -- otherwise the consultation runs on the default and only *claims*
// to have used what was asked for.
test('a model named in the target reaches the consultant CLI', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const argvOut = path.join(home, 'model-argv.json');
  process.env.STUB_ARGV_OUT = argvOut;
  const mgr = new JobManager();

  const started = mgr.start(reviewRequest({ target: 'codex:gpt-6-astra-mini' }));
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
  process.env.PEER_CONSULT_TIMEOUT_MS = '1200';
  const { JobManager: M } = await import(`../src/jobs.mjs?progress=${Date.now()}`);
  const mgr = new M();

  const started = mgr.start(reviewRequest());
  const view = await finish(mgr, started.job_id);

  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'timeout');
  assert.equal(view.failure.retriable, true);
  assert.match(view.failure.detail ?? '', /still working when the budget ran out/,
    'the trail the consultant left before it was killed');

  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
  process.env.STUB_BEHAVIOR = 'ok';
});

// "running" for twenty minutes is not a status a lead can act on. The point of
// reading the stream while it runs is that a heavy consultation can be cut
// short instead of waited out.
test('a running consultation reports what it is doing', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.PEER_CONSULT_TIMEOUT_MS = '5000';
  const { JobManager: M } = await import(`../src/jobs.mjs?live=${Date.now()}`);
  const mgr = new M();
  const started = mgr.start(reviewRequest());

  const seen = await waitFor(() => {
    const v = mgr.view(started.job_id);
    return v.status === 'running' && v.progress ? v : null;
  }, { timeoutMs: 4000, intervalMs: 25 });

  assert.match(seen.progress, /item event\(s\)/, 'the trail, while it is still being made');
  assert.match(seen.progress, /web_search/);

  mgr.cancel(started.job_id);
  await finish(mgr, started.job_id);
  assert.equal(mgr.view(started.job_id).progress, null, 'and nothing to report once it is over');

  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
  process.env.STUB_BEHAVIOR = 'ok';
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
  assert.equal(view.quality.evidence_basis, 'sufficient', 'the consultant\'s own claim, passed through');
  assert.equal(typeof view.quality.findings_without_grounds, 'number', 'a count, not an opinion');
});
