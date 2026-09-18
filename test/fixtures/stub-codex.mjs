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
  const list = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? list(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  ));
  fs.writeFileSync(process.env.STUB_CWD_OUT, JSON.stringify(list(process.cwd())));
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => run());
if (process.stdin.isTTY) run();

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function answer(overrides = {}) {
  return JSON.stringify({
    summary: 'Stub consultant summary of the proposal.',
    confidence: 'medium',
    evidence_basis: 'sufficient',
    stance: 'proceed',
    findings: [{ point: 'Retry storm risk', grounds: 'The excerpt retries without a cap.', impact: 'Cascading load', severity: 'high', confidence: 'medium' }],
    alternatives: [{ option: 'Token bucket', tradeoffs: 'More state', when_preferred: 'When bursts are common' }],
    unknowns: [{ item: 'Current QPS', why_it_matters: 'Sets the cap', how_to_obtain: 'Check the dashboard' }],
    decision_changers: [{ condition: 'QPS below 5', changes_to: 'No cap needed' }],
    next_checks: [{ check: 'Load test', method: 'Replay peak traffic', expected_signal: 'p99 under 300ms' }],
    remaining_disagreements: [],
    references: [{ title: 'brief', url: '(brief)', relevance: 'supplied excerpt' }],
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
  if (behavior === 'invalid') {
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    if (lastMessagePath) fs.writeFileSync(lastMessagePath, 'I cannot comply, here is some prose instead.');
    process.exit(0);
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
  if (behavior === 'leak_secret') {
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    if (lastMessagePath) {
      fs.writeFileSync(lastMessagePath, answer({ summary: 'Use the key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF to authenticate.' }));
    }
    process.exit(0);
  }

  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 450 } });
  if (lastMessagePath) fs.writeFileSync(lastMessagePath, answer());
  process.exit(0);
}
