#!/usr/bin/env node
// Stand-in for `opencode run --format json` used by the test suite. The event
// shapes match opencode 1.18.31 ({type, timestamp, sessionID, ...} lines on
// stdout, the answer as the last completed `text` part, usage and cost on the
// `step-finish` parts); 2.x shapes ({error:{type,message}}) are exercised by
// the adapter unit tests, and the no_route_then_ok behavior below emulates
// the 2.x credential-database flow end to end.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

// A capability probe target: the adapter discovers 2.x-only flags through
// `run --help`. STUB_HELP=standalone advertises --standalone (the 2.x flag
// list), the default hides it (the 1.18.31 list), and STUB_HELP=fail exits
// nonzero while mentioning the flag -- a diagnostic that must not count as
// support. STUB_HELP_DELAY_MS simulates a slow probe.
if (args.includes('--help')) {
  const delay = Number(process.env.STUB_HELP_DELAY_MS ?? 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (process.env.STUB_HELP === 'fail') {
    console.error('error: no such command; see --standalone docs');
    process.exit(1);
  }
  if (process.env.STUB_HELP === 'standalone') console.log('FLAGS\n  --standalone            Run with a private server instead of the background service');
  else console.log('FLAGS\n  --format choice         Output format (choices: default, json)');
  process.exit(0);
}

if (process.env.STUB_ARGV_OUT) fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(args));
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify(process.env));

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => run());
if (process.stdin.isTTY) run();

const emit = (type, data) =>
  process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID: 'ses_stub', ...data })}\n`);

function answer(overrides = {}) {
  return {
    summary: 'Stub opencode summary of the proposal.',
    confidence: 'medium',
    evidence_basis: 'sufficient',
    stance: 'proceed',
    findings: [{ point: 'Unbounded retry', grounds: 'The excerpt has no cap.', impact: 'Load amplification', severity: 'high', confidence: 'medium' }],
    alternatives: [{ option: 'Circuit breaker', tradeoffs: 'More moving parts', when_preferred: 'When the dependency flaps' }],
    unknowns: [{ item: 'Peak QPS', why_it_matters: 'Sets the cap', how_to_obtain: 'Check the dashboard' }],
    decision_changers: [{ condition: 'QPS below 5', changes_to: 'No cap needed' }],
    next_checks: [{ check: 'Load test', method: 'Replay peak traffic', expected_signal: 'p99 under 300ms' }],
    remaining_disagreements: [],
    references: [{ title: 'brief', url: '(brief)', relevance: 'supplied excerpt' }],
    ...overrides,
  };
}

const stepFinish = () => emit('step_finish', {
  // Shape verified live against opencode 1.18.31 (glm-5.3): tokens carries
  // total/input/output/reasoning plus cache.read/cache.write, and cost is a
  // number (0 on a coding plan).
  part: { type: 'step-finish', tokens: { total: 21, input: 10, output: 3, reasoning: 1, cache: { read: 7, write: 2 } }, cost: 0.02 },
});

async function run() {
  if (process.env.STUB_BRIEF_OUT) fs.writeFileSync(process.env.STUB_BRIEF_OUT, stdin);
  // STUB_BRIEF_OUT is a single shared path: in a fan-out several children would
  // overwrite each other's brief, so also drop one file per target.
  if (process.env.STUB_BRIEF_DIR) {
    fs.writeFileSync(path.join(process.env.STUB_BRIEF_DIR, `${process.env.SEVERALLY_TARGET ?? 'unknown'}.txt`), stdin);
  }
  const behavior = process.env.STUB_BEHAVIOR ?? 'ok';

  if (behavior === 'usage_limit') {
    emit('error', { error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit for this model. Try again later.' } } });
    process.exit(1);
  }
  if (behavior === 'auth') {
    emit('error', { error: { name: 'ProviderAuthError', data: { message: 'not logged in: invalid api key (401)' } } });
    process.exit(1);
  }
  if (behavior === 'model_unavailable') {
    emit('error', { error: { name: 'UnknownModelException', data: { message: 'model glm-99 does not exist or you do not have access to it' } } });
    process.exit(1);
  }
  if (behavior === 'invalid') {
    emit('text', { part: { type: 'text', text: 'I cannot comply, here is some prose instead.', time: { start: 1, end: 2 } } });
    stepFinish();
    process.exit(0);
  }
  if (behavior === 'retry_then_answer') {
    // A session.error the CLI recovered from: the error is recorded with the
    // answer, but the answer stands.
    emit('error', { error: { name: 'ProviderAuthError', data: { message: 'rate limited, retrying' } } });
    emit('text', { part: { type: 'text', text: JSON.stringify(answer()), time: { start: 1, end: 2 } } });
    stepFinish();
    process.exit(0);
  }
  if (behavior === 'hang') {
    // Same idea as the codex stub: leave a trail before wedging.
    emit('step_start', { part: { type: 'step-start' } });
    emit('tool_use', { part: { type: 'tool', tool: 'grep', state: { status: 'running' } } });
    const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
    if (process.env.STUB_GRANDCHILD_PID_OUT) fs.writeFileSync(process.env.STUB_GRANDCHILD_PID_OUT, String(gc.pid));
    setInterval(() => {}, 1e9);
    return;
  }
  if (behavior === 'leak_secret') {
    const leaked = answer({ summary: 'Authenticate with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF and retry.' });
    emit('text', { part: { type: 'text', text: JSON.stringify(leaked), time: { start: 1, end: 2 } } });
    stepFinish();
    process.exit(0);
  }

  if (behavior === 'answer_then_epilogue') {
    // The contract JSON lands in one completed part, then the model appends a
    // short prose epilogue as another completed part. The epilogue is the last
    // part (so it wins as the answer text), and carries no contract JSON --
    // the job must still complete by falling back to the earlier part.
    emit('text', { part: { type: 'text', text: JSON.stringify(answer()), time: { start: 1, end: 2 } } });
    emit('text', { part: { type: 'text', text: 'Done. Hope this helps!', time: { start: 3, end: 4 } } });
    stepFinish();
    process.exit(0);
  }

  if (behavior === 'no_route_after_delay' || behavior === 'no_route_then_ok') {
    // opencode 2.x ignores auth.json and reads credentials from the session
    // database. Emulate the real CLI: the failed run has already created the
    // schema, so create the credential table; if severally has seeded the
    // credential row, answer normally, otherwise emit the 2.x no-route error.
    // The _after_delay variant sleeps first (STUB_DELAY_MS) so the recovery
    // is left with less than its minimum window.
    const attempt = async () => {
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const dir = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local', 'share'), 'opencode');
        fs.mkdirSync(dir, { recursive: true });
        const db = new DatabaseSync(path.join(dir, 'opencode.db'));
        db.exec('CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)');
        const seeded = db.prepare("SELECT count(*) c FROM credential WHERE integration_id = 'zai-coding-plan'").get().c > 0;
        db.close();
        if (seeded) return 'seeded';
      } catch {
        // node:sqlite unavailable: behave like 1.x and answer.
      }
      return 'unseeded';
    };
    const state = await attempt();
    if (behavior === 'no_route_after_delay') {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_DELAY_MS ?? 2500)));
    }
    if (state === 'unseeded') {
      emit('error', { error: { type: 'provider.no-route', message: 'Model unavailable: zai-coding-plan/glm-5.3' } });
      process.exit(1);
    }
    // Seeded: the retry answers, optionally after its own delay so tests can
    // assert the job's duration covers BOTH attempts.
    const retryDelay = Number(process.env.STUB_RETRY_DELAY_MS ?? 0);
    if (retryDelay) await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  emit('step_start', { part: { type: 'step-start' } });
  emit('tool_use', { part: { type: 'tool', tool: 'grep', state: { status: 'completed' } } });
  // Interim prose between tool calls must lose to the final part.
  emit('text', { part: { type: 'text', text: 'Interim prose.', time: { start: 1, end: 2 } } });
  emit('text', { part: { type: 'text', text: JSON.stringify(answer()), time: { start: 3, end: 4 } } });
  stepFinish();
  process.exit(0);
}
