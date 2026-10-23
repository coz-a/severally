#!/usr/bin/env node
// Stand-in for `codex exec` used by the test suite. Behaviour is picked with
// STUB_BEHAVIOR so every branch of the adapter can be exercised offline.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (process.env.STUB_ARGV_OUT) fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(args));
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify(process.env));
// A recursive listing of the directory this consultant was launched in. It is
// the only way a test can tell a file that actually reached the consultant
// from one the brief merely claims is there.
if (process.env.STUB_CWD_OUT) {
  const list = (dir, prefix = '') =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  fs.writeFileSync(process.env.STUB_CWD_OUT, JSON.stringify(list(process.cwd())));
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  stdin += d;
});
process.stdin.on('end', () => run());
if (process.stdin.isTTY) run();

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function answer(overrides = {}) {
  return JSON.stringify({
    summary: 'Stub consultant summary of the proposal.',
    confidence: 'medium',
    evidence_basis: 'sufficient',
    stance: 'proceed',
    findings: [
      {
        point: 'Retry storm risk',
        grounds: 'The excerpt retries without a cap.',
        impact: 'Cascading load',
        severity: 'high',
        confidence: 'medium',
      },
    ],
    alternatives: [{ option: 'Token bucket', tradeoffs: 'More state', when_preferred: 'When bursts are common' }],
    unknowns: [{ item: 'Current QPS', why_it_matters: 'Sets the cap', how_to_obtain: 'Check the dashboard' }],
    decision_changers: [{ condition: 'QPS below 5', changes_to: 'No cap needed' }],
    next_checks: [{ check: 'Load test', method: 'Replay peak traffic', expected_signal: 'p99 under 300ms' }],
    remaining_disagreements: [],
    references: [{ title: 'brief', url: '(brief)', relevance: 'supplied excerpt' }],
    // A test that needs a thinner answer than the default merges its fields in.
    ...(process.env.STUB_ANSWER_PATCH ? JSON.parse(process.env.STUB_ANSWER_PATCH) : {}),
    ...overrides,
  });
}

function run() {
  if (process.env.STUB_BRIEF_OUT) fs.writeFileSync(process.env.STUB_BRIEF_OUT, stdin);
  // STUB_BRIEF_OUT is a single shared path: in a fan-out several children would
  // overwrite each other's brief, so also drop one file per target.
  if (process.env.STUB_BRIEF_DIR) {
    fs.writeFileSync(path.join(process.env.STUB_BRIEF_DIR, `${process.env.SEVERALLY_TARGET ?? 'unknown'}.txt`), stdin);
  }
  const behavior = process.env.STUB_BEHAVIOR ?? 'ok';
  const oIdx = args.indexOf('-o');
  const lastMessagePath = oIdx !== -1 ? args[oIdx + 1] : null;

  out({ type: 'thread.started', thread_id: 'stub-thread' });
  out({ type: 'turn.started' });

  if (behavior === 'usage_limit') {
    out({ type: 'error', message: "You've hit your usage limit. Visit https://example.invalid to purchase more credits." });
    out({ type: 'turn.failed', error: { message: 'usage limit' } });
    process.exit(0);
  }
  if (behavior === 'auth') {
    out({ type: 'error', message: 'Not logged in: run `codex login` first (401)' });
    process.exit(0);
  }
  if (behavior === 'auth_mixed') {
    out({ type: 'error', message: 'API Error: 429 invalid api key' });
    process.exit(0);
  }
  if (behavior === 'invalid') {
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    if (lastMessagePath) fs.writeFileSync(lastMessagePath, 'I cannot comply, here is some prose instead.');
    process.exit(0);
  }
  // A transient error the turn got past, then (or not) an answer.
  if (behavior.startsWith('recovered_')) {
    out({ type: 'error', message: 'Rate limit reached (429), retrying in 2s' });
    if (behavior === 'recovered_failed') {
      if (lastMessagePath) fs.writeFileSync(lastMessagePath, answer());
      out({ type: 'turn.failed', error: { message: 'Rate limit reached (429)' } });
      process.exit(0);
    }
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    const text = { recovered_ok: answer(), recovered_invalid: 'Some prose, no contract.' }[behavior];
    if (lastMessagePath && text) fs.writeFileSync(lastMessagePath, text);
    process.exit(0);
  }
  if (behavior === 'ignore_term') {
    // A consultant that shrugs off SIGTERM: only SIGKILL to its group ends it.
    process.on('SIGTERM', () => {});
    if (process.env.STUB_GRANDCHILD_PID_OUT) fs.writeFileSync(process.env.STUB_GRANDCHILD_PID_OUT, String(process.pid));
    setInterval(() => {}, 1e9);
    return;
  }
  if (behavior === 'hang') {
    // Work visibly for a moment before wedging: a real consultant that runs out
    // of budget has usually done something first, and that trail is what the
    // timeout report is made of.
    out({ type: 'item.started', item: { id: 'i1', type: 'command_execution' } });
    out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution' } });
    out({ type: 'item.started', item: { id: 'i2', type: 'web_search' } });
    // Spawn a grandchild so the test can assert the whole process tree dies.
    const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
    if (process.env.STUB_GRANDCHILD_PID_OUT) fs.writeFileSync(process.env.STUB_GRANDCHILD_PID_OUT, String(gc.pid));
    setInterval(() => {}, 1e9);
    return;
  }
  // The answer is written and the stub exits 0, but a grandchild it started
  // keeps stdout and stderr open (inherited, not ignored), so the pipes never
  // close on their own. _stubborn: the grandchild also shrugs off SIGTERM.
  // _invalid: no answer, only the leftover process. _hang: the stub itself
  // wedges too, for a deadline or a cancel.
  if (behavior.startsWith('orphan_pipe')) {
    const code = behavior.includes('stubborn')
      ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1e9)"
      : 'setInterval(()=>{},1e9)';
    const gc = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (process.env.STUB_GRANDCHILD_PID_OUT) fs.writeFileSync(process.env.STUB_GRANDCHILD_PID_OUT, String(gc.pid));
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    if (behavior.endsWith('_hang')) {
      setInterval(() => {}, 1e9);
      return;
    }
    if (lastMessagePath && !behavior.endsWith('_invalid')) fs.writeFileSync(lastMessagePath, answer());
    // Give the grandchild a moment to start before the stub goes.
    setTimeout(() => process.exit(0), 200);
    return;
  }
  // The answer is written and the stub exits 0, leaving a process in its group
  // that let go of stdout and stderr: nothing holds the pipes open.
  if (behavior === 'orphan_quiet') {
    const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
    if (process.env.STUB_GRANDCHILD_PID_OUT) fs.writeFileSync(process.env.STUB_GRANDCHILD_PID_OUT, String(gc.pid));
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    if (lastMessagePath) fs.writeFileSync(lastMessagePath, answer());
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (behavior === 'leak_secret') {
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    if (lastMessagePath) {
      fs.writeFileSync(
        lastMessagePath,
        answer({ summary: 'Use the key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF to authenticate.' }),
      );
    }
    process.exit(0);
  }
  if (behavior === 'leak_failure') {
    const message = '401 invalid api key ghp_abcdefghijklmnopqrstuvwxyz0123 ordinary-failure-canary';
    out({ type: 'error', message });
    process.stderr.write(message);
    process.exit(1);
  }

  // A consultant handed files looks at them, through its shell; one that runs
  // no command at all (no_commands) or only one that exits non-zero
  // (failed_command) is what the unread caveat is about.
  if (fs.existsSync('workspace') && behavior !== 'no_commands') {
    const status = behavior === 'failed_command' ? 'failed' : 'completed';
    const command = "/bin/bash -lc 'cat workspace/0-a.mjs'";
    out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command, status: 'in_progress' } });
    out({
      type: 'item.completed',
      item: { id: 'c1', type: 'command_execution', command, aggregated_output: 'SECRET FILE BODY', status },
    });
  }
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 450 } });
  if (lastMessagePath) fs.writeFileSync(lastMessagePath, answer());
  process.exit(0);
}
