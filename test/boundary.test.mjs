import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxEnv, exploreRequest, reviewRequest, asConsultant, waitFor, fileSymlinkUnavailable } from './helpers.mjs';

const home = sandboxEnv();
const JobManagerModule = await import('../src/jobs.mjs');
const { JobManager } = JobManagerModule;
const { prepareSandbox: agySandbox } = await import('../src/adapters/antigravity-sandbox.mjs');
const { prepareSandbox: opencodeSandbox } = await import('../src/adapters/opencode-sandbox.mjs');
const claude = await import('../src/adapters/claude-code.mjs');
const codex = await import('../src/adapters/codex.mjs');
const { classifyMessage, isRetriable } = await import('../src/failures.mjs');

function workdir() {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-boundary-'));
  fs.mkdirSync(path.join(job, 'work'));
  return path.join(job, 'work');
}

// Runs the hook agy would run, with the call agy would pipe to it.
// No output would let the call through, so a silent hook is reported as
// such, never read as an allow: every allow below was answered explicitly.
function hook(sandbox, toolCall, extra = {}, input = JSON.stringify({ toolCall, ...extra })) {
  const hooks = JSON.parse(fs.readFileSync(path.join(sandbox.root, '.gemini', 'config', 'hooks.json'), 'utf8'));
  assert.equal(hooks.severally.PreToolUse[0].matcher, '*');
  const out = spawnSync(process.execPath, [path.join(sandbox.root, 'tool-allowlist.mjs')], {
    input,
    // agy runs the hook from inside the sandbox home, which is itself protected.
    cwd: sandbox.root,
  }).stdout.toString();
  return out ? JSON.parse(out).decision : 'no answer';
}

test('the agy hook answers every call, and denies what it cannot read or check', () => {
  const sandbox = agySandbox({ workdir: workdir() });
  assert.equal(hook(sandbox, null, {}, ''), 'deny', 'empty input');
  assert.equal(hook(sandbox, null, {}, '{"toolCall":'), 'deny', 'broken JSON');
  let deep = '/etc/hostname';
  for (let i = 0; i < 40; i++) deep = { a: deep };
  assert.equal(hook(sandbox, { name: 'view_file', args: deep }), 'deny', 'nested past the walk');
  let shallow = '/etc/hostname';
  for (let i = 0; i < 5; i++) shallow = { a: shallow };
  assert.equal(hook(sandbox, { name: 'view_file', args: shallow }), 'allow');
  sandbox.cleanup();
});

test('the agy hook allows only the read and web tools, and refuses agent tools and new ones', () => {
  const sandbox = agySandbox({ workdir: workdir() });
  for (const name of ['view_file', 'read_file', 'search_web', 'read_url_content', 'finish'])
    assert.equal(hook(sandbox, { name }), 'allow', name);
  for (const name of [
    'invoke_subagent',
    'define_subagent',
    'manage_subagents',
    'send_message',
    'schedule',
    'manage_task',
    'ask_question',
    'write_to_file',
    'run_command',
    'some_tool_added_next_release',
  ]) {
    assert.equal(hook(sandbox, { name }), 'deny', name);
  }
  sandbox.cleanup();
});

test('the agy hook refuses credential and history paths, symlinks resolved, and allows the rest', () => {
  const work = workdir();
  const sandbox = agySandbox({ workdir: work });
  // The shape agy 1.4.0 sends: the arguments are under `args`.
  const view = (p) => hook(sandbox, { name: 'view_file', args: { AbsolutePath: p, toolAction: 'Viewing', toolSummary: 'View' } });
  assert.equal(view('/etc/hostname'), 'allow');
  assert.equal(view(path.join(os.homedir(), '.ssh', 'id_ed25519')), 'deny');
  // severally's own history, wherever SEVERALLY_HOME put it.
  assert.equal(view(path.join(home, 'history', 'index.jsonl')), 'deny');
  assert.equal(view('~/.ssh/config'), 'deny', '~ is expanded');
  assert.equal(view(`${os.homedir()}/.ssh/a://../id_rsa`), 'deny', 'a :// inside a path is not a URL');
  assert.equal(hook(sandbox, { name: 'read_url_content', args: { Url: `file://${os.homedir()}/.ssh/id_rsa` } }), 'deny');
  assert.equal(hook(sandbox, { name: 'read_url_content', args: { Url: 'https://example.com/.env' } }), 'allow');
  // Description text is not a path, even though the hook runs inside the protected sandbox home.
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-control-'));
  assert.equal(
    hook(
      sandbox,
      {
        name: 'view_file',
        args: {
          AbsolutePath: path.join(controlDir, 'control.txt'),
          toolAction: 'Reading control.txt',
          toolSummary: 'Read control.txt',
        },
      },
      { workspacePaths: [work] },
    ),
    'allow',
  );
  assert.equal(
    hook(sandbox, { name: 'view_file', args: { AbsolutePath: '.env' } }, { workspacePaths: ['/srv/app'] }),
    'deny',
    'relative to the workspace',
  );
  // agy 1.4.3 reads with read_file; its paths are checked the same way.
  assert.equal(hook(sandbox, { name: 'read_file', args: { AbsolutePath: path.join(os.homedir(), '.ssh', 'id_rsa') } }), 'deny');
  assert.equal(hook(sandbox, { name: 'read_file', args: { AbsolutePath: '/etc/hostname' } }), 'allow');
  // Older releases sent `parameters`; still checked.
  assert.equal(hook(sandbox, { name: 'view_file', parameters: { AbsolutePath: '/srv/.env' } }), 'deny');
  // The final answer is text, not a path: naming a protected file in it must not block the answer.
  assert.equal(hook(sandbox, { name: 'finish', args: { result: `see /srv/.env and ${os.homedir()}/.ssh/id_rsa` } }), 'allow');
  assert.equal(view('/srv/app/.env'), 'deny');
  assert.equal(view('/srv/app/.env.production'), 'deny');
  assert.equal(view('/srv/app/.envrc'), 'allow');
  // The sandbox holds the linked agy token, so its own home is protected too.
  assert.equal(view(path.join(sandbox.root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')), 'deny');
  // ...except the copy of a long page read_url_content saves there for the model to view.
  const brain = path.join(sandbox.root, '.gemini', 'antigravity-cli', 'brain', '59d3eb97-f8de-40f7-b3f1-2ff19bc7a68d');
  assert.equal(view(path.join(brain, '.system_generated', 'steps', '2', 'content.md')), 'allow');
  assert.equal(view(path.join(brain, '.system_generated', 'logs', 'transcript.jsonl')), 'deny');
  assert.equal(
    view(path.join(brain, '.system_generated', 'steps', '2', '..', '..', '..', '..', 'antigravity-oauth-token')),
    'deny',
  );
  assert.equal(
    view(
      path.join(
        home,
        'homes',
        'job_other',
        '.gemini',
        'antigravity-cli',
        'brain',
        'x',
        '.system_generated',
        'steps',
        '1',
        'content.md',
      ),
    ),
    'deny',
    'another sandbox',
  );
  sandbox.cleanup();
});

test('the agy hook refuses a symlink to a protected file', { skip: fileSymlinkUnavailable() }, () => {
  const sandbox = agySandbox({ workdir: workdir() });
  const view = (p) => hook(sandbox, { name: 'view_file', args: { AbsolutePath: p } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-link-'));
  fs.writeFileSync(path.join(dir, '.env'), 'X=1');
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));
  assert.equal(view(path.join(dir, 'innocent.txt')), 'deny', 'a symlink to a protected file is refused');
  sandbox.cleanup();
});

test('with the network off, agy loses its web tools and read_url is denied', () => {
  const sandbox = agySandbox({ workdir: workdir(), network: 'off' });
  assert.equal(hook(sandbox, { name: 'search_web' }), 'deny');
  assert.equal(hook(sandbox, { name: 'read_url_content' }), 'deny');
  assert.equal(hook(sandbox, { name: 'view_file', args: { AbsolutePath: '/etc/hostname' } }), 'allow');
  const settings = JSON.parse(fs.readFileSync(path.join(sandbox.root, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes('read_url(*)'));
  assert.ok(!settings.permissions.allow.includes('read_url(*)'));
  sandbox.cleanup();
});

test('with the network off, opencode denies webfetch and websearch', () => {
  const sandbox = opencodeSandbox({ workdir: workdir(), network: 'off' });
  const cfg = JSON.parse(fs.readFileSync(path.join(sandbox.root, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(cfg.permission.webfetch, 'deny');
  assert.equal(cfg.permission.websearch, 'deny');
  assert.equal(cfg.permission.read['*'], 'allow');
  assert.deepEqual(sandbox.tools, ['read']);
  sandbox.cleanup();
});

test('claude-code is launched with read deny rules, and without web tools when the network is off', () => {
  const on = claude.buildInvocation({ consultant: asConsultant('claude-code'), workdir: '/w', guardrails: 'g' }).args;
  const settings = JSON.parse(on[on.indexOf('--settings') + 1]);
  assert.ok(settings.permissions.deny.includes('Read(~/.ssh/**)'));
  const history = path.join(home, 'history');
  const relative = path.relative(os.homedir(), history).replaceAll('\\', '/');
  const spec =
    relative && !relative.startsWith('../') && !path.isAbsolute(relative)
      ? `~/${relative}`
      : `//${claude.posixAbsolute(history).replace(/^\/+/, '')}`;
  assert.ok(settings.permissions.deny.includes(`Read(${spec}/**)`));
  assert.equal(claude.posixAbsolute('C:\\Users\\a'), '/c/Users/a');
  assert.ok(settings.permissions.deny.includes('Read(//**/.env)'));
  assert.equal(on[on.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');

  const off = claude.buildInvocation({
    consultant: asConsultant('claude-code'),
    workdir: '/w',
    guardrails: 'g',
    network: 'off',
  }).args;
  assert.equal(off[off.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(!off.includes('--allowedTools'), 'no allow rule for web tools that are not there');
  assert.equal(claude.boundary({ args: off, hasExposedPaths: false }).web, false);
});

test('codex is launched without sub-agent tools', () => {
  const args = codex.buildInvocation({ consultant: asConsultant('codex'), workdir: '/w', schemaPath: '/s' }).args;
  assert.ok(args.includes('agents.enabled=false'), 'codex enables sub-agents by default');
});

test('codex asks for the elevated sandbox on Windows only', () => {
  const args = codex.buildInvocation({ consultant: asConsultant('codex'), workdir: '/w', schemaPath: '/s' }).args;
  // The unelevated Windows sandbox refuses a profile with deny-read entries.
  assert.equal(args.includes('windows.sandbox="elevated"'), process.platform === 'win32');
});

test('codex turns web search off with the network', () => {
  const off = codex.buildInvocation({ consultant: asConsultant('codex'), workdir: '/w', schemaPath: '/s', network: 'off' }).args;
  assert.ok(off.includes('tools.web_search=false'));
  assert.ok(off.includes('web_search="disabled"'), 'codex 0.163 keeps searching with tools.web_search=false alone');
  assert.equal(codex.boundary({ args: off }).web, false);
  const on = codex.buildInvocation({ consultant: asConsultant('codex'), workdir: '/w', schemaPath: '/s' }).args;
  assert.ok(on.includes('tools.web_search=true'));
  assert.ok(!on.includes('web_search="disabled"'));
});

test('a transient refusal is rate_limited, a used-up quota stays usage_limit', () => {
  assert.equal(classifyMessage('API Error: 429 invalid api key'), 'auth');
  assert.equal(classifyMessage('429 insufficient_quota'), 'usage_limit');
  assert.equal(classifyMessage('401 invalid api key'), 'auth');
  assert.equal(classifyMessage('API Error: 429 Too Many Requests'), 'rate_limited');
  assert.equal(classifyMessage('RESOURCE_EXHAUSTED'), 'cli_error');
  assert.equal(classifyMessage('429 insufficient_quota: invalid api key'), 'usage_limit');
  assert.equal(classifyMessage('Overloaded'), 'rate_limited');
  assert.equal(classifyMessage("You've hit your usage limit"), 'usage_limit');
  assert.equal(classifyMessage('quota exceeded (429)'), 'usage_limit');
  // agy, 2026-10-18: retried twice as cli_error before this was matched.
  assert.equal(
    classifyMessage('Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 145h4m57s.'),
    'usage_limit',
  );
  assert.equal(classifyMessage('Variant unavailable for opencode/nemotron-3-ultra-free: high'), 'model_unavailable');
  // A number counts as a status only where a status is written.
  assert.equal(classifyMessage('Not logged in: run `codex login` first (401)'), 'auth');
  assert.equal(classifyMessage('RESOURCE_EXHAUSTED (code 429): busy'), 'rate_limited');
  assert.equal(classifyMessage('HTTP/1.1 503'), 'rate_limited');
  assert.equal(classifyMessage('request failed with status code: 403'), 'auth');
  assert.equal(classifyMessage('{"error":{"code": 404}}'), 'model_unavailable');
  assert.equal(classifyMessage('upstream [502]'), 'rate_limited');
  assert.equal(classifyMessage('read 403 tokens from file'), 'cli_error');
  assert.equal(classifyMessage('Error at line 502 of foo.ts'), 'cli_error');
  assert.equal(classifyMessage('API Error: 400 bad request; 401 bytes'), 'cli_error');
  assert.equal(isRetriable('rate_limited'), true);
  assert.equal(isRetriable('usage_limit'), false);
});

test('a rate-limited run is re-run once and the earlier failure is kept', async () => {
  process.env.STUB_BEHAVIOR = 'rate_limited_once';
  process.env.STUB_COUNT_FILE = path.join(home, 'count-once');
  const mgr = new JobManager();
  const { job_id } = mgr.start(exploreRequest());
  await mgr.jobs.get(job_id).promise;
  const view = mgr.view(job_id);
  assert.equal(view.status, 'completed');
  assert.equal(fs.readFileSync(process.env.STUB_COUNT_FILE, 'utf8'), '2');
  assert.equal(view.retries.length, 1);
  assert.equal(view.retries[0].failure_kind, 'rate_limited');
  // The failed attempt spent quota too: it keeps its own usage, and the totals add it.
  assert.equal(view.retries[0].usage.input_tokens, 40);
  const totals = mgr.usageTotals()[view.target];
  assert.equal(totals.attempts, 2);
  assert.equal(totals.input_tokens, 40 + view.usage.input_tokens);
  assert.equal(totals.cost_usd, 0.002 + view.usage.cost_usd);
});

test('a run that stays rate-limited stops after the configured re-runs and says so', async () => {
  process.env.STUB_BEHAVIOR = 'rate_limited';
  process.env.STUB_COUNT_FILE = path.join(home, 'count-always');
  const mgr = new JobManager();
  const { job_id } = mgr.start(exploreRequest());
  await mgr.jobs.get(job_id).promise;
  const view = mgr.view(job_id);
  assert.equal(view.status, 'failed');
  assert.equal(view.failure.kind, 'rate_limited');
  assert.equal(fs.readFileSync(process.env.STUB_COUNT_FILE, 'utf8'), '3', 'the first run plus two re-runs');
  assert.equal(view.retries.length, 2);
});

test('a usage_limit failure is not re-run', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const mgr = new JobManager();
  const { job_id } = mgr.start(exploreRequest());
  await mgr.jobs.get(job_id).promise;
  const view = mgr.view(job_id);
  assert.equal(view.failure.kind, 'usage_limit');
  assert.deepEqual(view.retries, []);
});

test('a timed-out consultant leaves its partial output beside the failure, not as an answer', async () => {
  process.env.STUB_BEHAVIOR = 'sleep';
  process.env.SEVERALLY_TIMEOUT_MS = '1500';
  try {
    const mgr = new JobManager();
    const { job_id } = mgr.start(exploreRequest());
    await mgr.jobs.get(job_id).promise;
    const view = mgr.view(job_id);
    assert.equal(view.failure.kind, 'timeout');
    assert.equal(view.result, null);
    assert.equal(view.partial_output.partial, true);
    assert.match(view.partial_output.tail, /partial line one/);
  } finally {
    process.env.SEVERALLY_TIMEOUT_MS = '20000';
  }
});

test('a network-off consultation tells the consultant so and records the boundary', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const argvOut = path.join(home, 'argv-off.json');
  const briefOut = path.join(home, 'brief-off.txt');
  process.env.STUB_ARGV_OUT = argvOut;
  process.env.STUB_BRIEF_OUT = briefOut;
  try {
    const mgr = new JobManager();
    const { job_id } = mgr.start(exploreRequest({ network: 'off' }));
    await mgr.jobs.get(job_id).promise;
    const view = mgr.view(job_id);
    assert.equal(view.status, 'completed');
    assert.equal(view.network, 'off');
    assert.equal(view.boundary.web, false);
    assert.equal(view.boundary.protected_paths, 'denied (permission rules)');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.match(fs.readFileSync(briefOut, 'utf8'), /Web search and browsing are switched off/);
  } finally {
    delete process.env.STUB_ARGV_OUT;
    delete process.env.STUB_BRIEF_OUT;
  }
});

test('the default is network on, and the boundary record survives in history', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const { job_id, chain_id } = mgr.start(reviewRequest());
  await mgr.jobs.get(job_id).promise;
  const view = mgr.view(job_id);
  assert.equal(view.network, 'on');
  assert.equal(view.boundary.web, true);
  assert.match(view.boundary.protected_paths, /^denied by path/);
  const round = JSON.parse(fs.readFileSync(path.join(home, 'history', chain_id, 'round-01.json'), 'utf8'));
  assert.deepEqual(round.boundary, view.boundary);
});

test('expose_paths leaves credential files out and the brief does not say where the copy came from', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-expose-'));
  fs.writeFileSync(path.join(src, 'app.js'), 'export {}\n');
  fs.writeFileSync(path.join(src, '.env'), 'X=1\n');
  const briefOut = path.join(home, 'brief-expose.txt');
  const cwdOut = path.join(home, 'cwd-expose.json');
  process.env.STUB_BRIEF_OUT = briefOut;
  process.env.STUB_CWD_OUT = cwdOut;
  try {
    const mgr = new JobManager();
    const req = reviewRequest();
    const { job_id } = mgr.start({ ...req, context: { ...req.context, expose_paths: [src] } });
    await mgr.jobs.get(job_id).promise;
    assert.equal(mgr.view(job_id).status, 'completed');
    const brief = fs.readFileSync(briefOut, 'utf8');
    assert.ok(!brief.includes(src), 'the source path is not sent to the consultant');
    assert.match(brief, /1 credential or history path\(s\) were left out on purpose/);
    const listed = JSON.stringify(JSON.parse(fs.readFileSync(cwdOut, 'utf8')));
    assert.match(listed, /app\.js/);
    assert.doesNotMatch(listed, /\.env/);
  } finally {
    delete process.env.STUB_BRIEF_OUT;
    delete process.env.STUB_CWD_OUT;
  }
});

test('opencode refuses unnamed tools and Code Mode, and reads everywhere but the protected paths', () => {
  const sandbox = opencodeSandbox({ workdir: workdir() });
  const cfg = JSON.parse(fs.readFileSync(path.join(sandbox.root, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(Object.keys(cfg.permission)[0], '*', 'the default comes first: the last matching rule wins');
  assert.equal(cfg.permission['*'], 'deny');
  assert.equal(cfg.permission.execute, 'deny', 'Code Mode reached the web with webfetch denied');
  assert.equal(cfg.tools.execute, false);
  for (const key of ['read', 'external_directory']) {
    assert.equal(cfg.permission[key]['*'], 'allow');
    assert.equal(cfg.permission[key][`${os.homedir().replaceAll('\\', '/')}/.ssh/**`], 'deny');
    assert.equal(cfg.permission[key]['**/.env'], 'deny');
  }
  sandbox.cleanup();
});

test('OpenCode denies protected reads when the CLI authorizes a location- or worktree-relative resource', () => {
  const work = path.join(home, 'jobs', 'relative-probe', 'work');
  fs.mkdirSync(work, { recursive: true });
  const sandbox = opencodeSandbox({ workdir: work });
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(sandbox.root, '.config', 'opencode', 'opencode.json'), 'utf8'));
    // Independent evaluation of the CLI's documented last-match wildcard rules.
    const match = (pattern, resource) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(resource);
    const decide = (resource) =>
      Object.entries(cfg.permission.read)
        .filter(([p]) => match(p, resource))
        .at(-1)?.[1];
    const protectedFile = path.join(home, 'homes', 'another-job', 'secret.txt');
    const resources = [protectedFile, path.relative(home, protectedFile), path.relative(path.dirname(home), protectedFile)].map(
      (p) => p.replaceAll('\\', '/'),
    );
    for (const resource of resources) assert.equal(decide(resource), 'deny', resource);
    assert.equal(decide('workspace/ordinary.txt'), 'allow');
    assert.equal(decide('workspace/.env'), 'deny');
    assert.equal(cfg.permission.grep, 'deny', 'grep of an ancestor must not expose protected descendants');
    assert.equal(cfg.permission.glob, 'deny', 'glob has no per-file read check');
  } finally {
    sandbox.cleanup();
  }
});

test("every consultant gets its own working directory as PWD, not the server's", async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const envOut = path.join(home, 'env-pwd.json');
  process.env.STUB_ENV_OUT = envOut;
  try {
    const mgr = new JobManager();
    const { job_id } = mgr.start(reviewRequest());
    await mgr.jobs.get(job_id).promise;
    const env = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    assert.notEqual(env.PWD, process.cwd());
    assert.match(env.PWD, /work$/);
  } finally {
    delete process.env.STUB_ENV_OUT;
  }
});

test('tool calls are counted from each CLI event stream, refused ones marked', async () => {
  const agy = await import('../src/adapters/antigravity.mjs');
  const oc = await import('../src/adapters/opencode.mjs');
  const lines = (...o) => o.map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(
    codex.toolCalls({
      stdout: lines(
        { type: 'item.started', item: { id: 'a', type: 'command_execution' } },
        { type: 'item.completed', item: { id: 'a', type: 'command_execution' } },
        { type: 'item.completed', item: { id: 'b', type: 'collab_tool_call', tool: 'spawn_agent', status: 'failed' } },
        { type: 'item.completed', item: { id: 'c', type: 'agent_message', text: 'x' } },
      ),
    }),
    { command_execution: 1, 'collab_tool_call:spawn_agent:error': 1 },
  );
  assert.deepEqual(
    agy.toolCalls({
      stdout: lines(
        { event: 'step_update', step_update: { step_index: 1, tool_name: 'view_file', state: 'RUNNING' } },
        { event: 'step_update', step_update: { step_index: 1, tool_name: 'view_file', state: 'DONE' } },
        { event: 'step_update', step_update: { step_index: 2, tool_name: 'invoke_subagent', state: 'ERROR' } },
      ),
    }),
    { view_file: 1, 'invoke_subagent:error': 1 },
  );
  assert.deepEqual(
    oc.toolCalls({
      stdout: lines(
        { type: 'tool_use', part: { callID: 'x', tool: 'read', state: { status: 'completed' } } },
        { type: 'tool_use', part: { callID: 'y', tool: 'task', state: { status: 'error' } } },
      ),
    }),
    { read: 1, 'task:error': 1 },
  );
});

test('codex runs under a permission profile that denies the protected roots, not -s read-only', () => {
  const { args } = codex.buildInvocation({ consultant: asConsultant('codex'), workdir: '/tmp/w/work', schemaPath: '/tmp/s' });
  assert.ok(!args.includes('-s'));
  const rules = args.find((a) => a.startsWith('permissions.severally.filesystem='));
  assert.ok(
    rules.includes(`${JSON.stringify(fs.realpathSync.native(path.join(home, 'homes')).replaceAll('\\', '/'))} = "none"`),
    'every synthesised home, including later ones',
  );
  assert.match(codex.boundary({ args }).protected_paths, /^denied by path/);
  const { extraArgsProblem } = JobManagerModule;
  assert.ok(extraArgsProblem('codex', args, ['-s', 'read-only']), '-s would replace the profile');
});

test('usage totals add only what each CLI reported', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  for (let i = 0; i < 2; i++) {
    const { job_id } = mgr.start(reviewRequest());
    await mgr.jobs.get(job_id).promise;
  }
  const totals = mgr.usageTotals();
  const target = Object.keys(totals)[0];
  assert.equal(totals[target].consultations, 2);
  const one = mgr.jobs.values().next().value.usage;
  for (const [k, v] of Object.entries(one)) {
    if (typeof v === 'number') assert.equal(totals[target][k], v * 2, k);
    else assert.ok(!(k in totals[target]), `${k} was not reported, so it has no total`);
  }
  // Codex reports no cost: said, not silently left out.
  assert.ok(totals[target].not_reported.includes('cost_usd'));
  assert.ok(!totals[target].not_reported.includes('input_tokens'));
});

test('usage totals count a cancelled consultation as unreported instead of leaving it out', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const mgr = new JobManager();
  const { job_id: done } = mgr.start(reviewRequest());
  await mgr.jobs.get(done).promise;
  const target = mgr.view(done).target;
  assert.equal(mgr.usageTotals()[target].unreported, 0);
  process.env.STUB_BEHAVIOR = 'hang';
  const { job_id: hung } = mgr.start(reviewRequest());
  mgr.cancel(hung);
  await mgr.jobs.get(hung).promise;
  assert.equal(mgr.view(hung).status, 'cancelled');
  const totals = mgr.usageTotals()[target];
  assert.equal(totals.unreported, 1);
  assert.equal(totals.consultations, 1, 'only the consultation that reported is summed');
});

test('a running poll leaves out the limits; a fan-out carries one copy, on the group', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const mgr = new JobManager();
  const { job_id } = mgr.start(reviewRequest());
  assert.equal(mgr.view(job_id).limits, null);
  mgr.cancel(job_id);
  await mgr.jobs.get(job_id).promise;
  assert.ok(mgr.view(job_id).limits, 'the finished view carries them again');
  process.env.STUB_BEHAVIOR = 'ok';
  const { group_id } = mgr.start(reviewRequest({ target: undefined, targets: ['codex', 'claude-code'] }));
  await Promise.all(mgr.groups.get(group_id).job_ids.map((jid) => mgr.jobs.get(jid).promise));
  const group = await mgr.waitGroup(group_id, 0, { detail: 'full' });
  assert.ok(group.limits);
  assert.ok(group.members.every((m) => !('limits' in m)));
  // By default a finished group leaves them out too: they grow with every consultant configured.
  assert.equal(mgr.groupView(group_id).limits, null);
});

test('an OpenCode model listed with a bare trailing # runs with no variant', async () => {
  const oc = await import('../src/adapters/opencode.mjs');
  const m = (model) => {
    const a = oc.buildInvocation({ consultant: asConsultant('opencode', { model }) }).args;
    return a[a.indexOf('-m') + 1];
  };
  assert.equal(m('opencode/nemotron-3-ultra-free#'), 'opencode/nemotron-3-ultra-free');
  assert.equal(m('zai-coding-plan/glm-5.3#max'), 'zai-coding-plan/glm-5.3#max');
  assert.match(m('zai-coding-plan/glm-5.3'), /^zai-coding-plan\/glm-5\.3#/);
});

test('codex expands legacy job homes, since its profile has no wildcard', () => {
  const legacy = path.join(home, 'jobs', 'job_legacy', 'home');
  fs.mkdirSync(legacy, { recursive: true });
  try {
    const rules = codex.filesystemPermissions();
    assert.ok(rules.includes(`${JSON.stringify(legacy.replaceAll('\\', '/'))} = "none"`));
    assert.ok(!rules.includes('*'), 'no literal wildcard reaches codex');
  } finally {
    fs.rmSync(path.join(home, 'jobs', 'job_legacy'), { recursive: true, force: true });
  }
});

test('on Windows, codex is not handed protected paths that do not exist', () => {
  const missing = path.join(os.homedir(), '.netrc');
  const present = path.join(os.homedir(), '.ssh');
  assert.equal(fs.existsSync(missing), false);
  fs.mkdirSync(present, { recursive: true });
  const moduleUrl = new URL('../src/adapters/codex.mjs', import.meta.url).href;
  const rules = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `Object.defineProperty(process, 'platform', { value: 'win32' }); const a = await import(${JSON.stringify(moduleUrl)}); console.log(a.filesystemPermissions());`,
    ],
    { encoding: 'utf8' },
  ).stdout;
  const fwd = (p) => fs.realpathSync.native(p).replaceAll('\\', '/');
  assert.ok(!rules.includes(`${JSON.stringify(missing.replaceAll('\\', '/'))} = "none"`), rules);
  assert.ok(rules.includes(`${JSON.stringify(fwd(present))} = "none"`), rules);
});

test('synthetic credentials are masked in the sent brief and exposed file copies', async () => {
  const store = await import('../src/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-mask-probe-'));
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  const canary = 'ordinary-boundary-canary';
  const source = path.join(dir, 'sample.txt');
  const briefOut = path.join(dir, 'brief.txt');
  fs.writeFileSync(source, `${canary}\n${secret}\n`);
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.STUB_BRIEF_OUT = briefOut;
  const mgr = new JobManager();
  const started = mgr.start(
    reviewRequest({
      question: `Review ${canary} ${secret}`,
      context: { facts: [`${canary} ${secret}`], proposal: 'Review the supplied example.', expose_paths: [source] },
    }),
  );
  try {
    await waitFor(() => fs.existsSync(briefOut));
    const brief = fs.readFileSync(briefOut, 'utf8');
    const copy = fs.readFileSync(path.join(store.jobDir(started.job_id), 'work', 'workspace', '0-sample.txt'), 'utf8');
    for (const text of [brief, copy]) {
      assert.ok(!text.includes(secret));
      assert.match(text, /REDACTED/);
      assert.ok(text.includes(canary), 'ordinary content must still reach the consultant');
    }
    assert.ok(fs.readFileSync(source, 'utf8').includes(secret), 'mask only the published copy');
  } finally {
    mgr.cancel(started.job_id);
    await mgr.jobs.get(started.job_id).promise;
    delete process.env.STUB_BRIEF_OUT;
    process.env.STUB_BEHAVIOR = 'ok';
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic credentials in answers and lead records never enter history or exports', async () => {
  const { exportChain } = await import('../src/export.mjs');
  const secret = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
  process.env.STUB_BEHAVIOR = 'leak_secret';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  try {
    await mgr.jobs.get(started.job_id).promise;
    assert.equal(mgr.view(started.job_id).status, 'completed');
    mgr.record({
      job_id: started.job_id,
      entries: [{ id: 'f1', verdict: 'unverified', note: secret, effect: `ordinary-record-canary ${secret}` }],
    });
    const exported = exportChain({ chain_id: started.chain_id }).markdown;
    const history = fs
      .readdirSync(path.join(home, 'history', started.chain_id))
      .map((f) => fs.readFileSync(path.join(home, 'history', started.chain_id, f), 'utf8'))
      .join('\n');
    for (const text of [JSON.stringify(mgr.view(started.job_id)), history, exported]) {
      assert.ok(!text.includes(secret));
      assert.match(text, /REDACTED/);
      assert.match(text, /ordinary-record-canary/);
    }
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
  }
});

test(
  'a credential in the detail of a failure never enters the view or the history',
  { skip: process.platform === 'win32' },
  async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    process.env.STUB_BEHAVIOR = 'orphan_pipe_leak';
    const mgr = new JobManager();
    const started = mgr.start(reviewRequest());
    try {
      await mgr.jobs.get(started.job_id).promise;
      const view = mgr.view(started.job_id);
      assert.equal(view.failure.kind, 'cli_error');
      assert.match(view.failure.detail, /detail-canary/, 'the detail is kept, only the credential is masked');
      const history = fs.readFileSync(path.join(home, 'history', started.chain_id, 'round-01.json'), 'utf8');
      for (const text of [JSON.stringify(view), history]) assert.ok(!text.includes(secret));
      assert.match(view.failure.detail, /REDACTED/);
    } finally {
      process.env.STUB_BEHAVIOR = 'ok';
    }
  },
);

test('synthetic credentials in CLI failure details never enter history or exports', async () => {
  const { exportChain } = await import('../src/export.mjs');
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  process.env.STUB_BEHAVIOR = 'leak_failure';
  const mgr = new JobManager();
  const started = mgr.start(reviewRequest());
  try {
    await mgr.jobs.get(started.job_id).promise;
    const view = mgr.view(started.job_id);
    assert.equal(view.failure.kind, 'auth');
    const history = fs.readFileSync(path.join(home, 'history', started.chain_id, 'round-01.json'), 'utf8');
    for (const text of [JSON.stringify(view), history, exportChain({ chain_id: started.chain_id }).markdown]) {
      assert.ok(!text.includes(secret));
      assert.match(text, /REDACTED/);
      assert.match(text, /ordinary-failure-canary/);
    }
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
  }
});
