// Child-process plumbing: sanitised environment, own process group, hard
// wall-clock timeout, cancellation, and output caps.

import { spawn } from 'node:child_process';
import { POLICY } from './policy.mjs';

const DROP_EXACT = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT',
  'ANTHROPIC_LOG', 'NODE_OPTIONS',
]);
const DROP_PREFIX = ['CLAUDE_CODE_', 'PEER_CONSULT_', 'MCP_'];

// Each consultant sees only its own vendor's credentials.
const TARGET_DROP_PREFIX = {
  codex: ['ANTHROPIC_', 'GEMINI_', 'GOOGLE_', 'AGY_', 'ANTIGRAVITY_'],
  'claude-code': ['OPENAI_', 'CODEX_', 'GEMINI_', 'GOOGLE_', 'AGY_', 'ANTIGRAVITY_'],
  antigravity: ['ANTHROPIC_', 'OPENAI_', 'CODEX_'],
};

/**
 * Build the child environment. The parent's agent-session wiring (messaging
 * sockets, session ids, entrypoint markers) and the other vendor's credentials
 * are removed; a recursion marker is added.
 */
export function childEnv(target, extra = {}) {
  const dropPrefixes = [...DROP_PREFIX, ...(TARGET_DROP_PREFIX[target] ?? [])];
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (DROP_EXACT.has(k)) continue;
    if (dropPrefixes.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.PEER_CONSULT_ACTIVE = '1';
  env.PEER_CONSULT_ROLE = 'consultant';
  env.PEER_CONSULT_TARGET = target;
  return { ...env, ...extra };
}

export class ProcHandle {
  constructor(child) {
    this.child = child;
    this.killed = false;
  }

  /** Kill the child and every descendant it spawned. */
  stop(signal = 'SIGTERM') {
    if (this.killed || !this.child || this.child.exitCode !== null) return;
    this.killed = true;
    const pid = this.child.pid;
    if (!pid) return;
    try { process.kill(-pid, signal); } catch { try { this.child.kill(signal); } catch { /* gone */ } }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }, POLICY.killGraceMs).unref();
  }
}

/**
 * @returns {{handle: ProcHandle, done: Promise<{code, signal, stdout, stderr, timedOut, cancelled, truncated}>}}
 */
export function runChild({ command, args, cwd, env, input, timeoutMs, onCancelSignal }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true, // own process group => descendants die with it
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const handle = new ProcHandle(child);
  const cap = POLICY.output.rawCaptureMax;

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  let cancelled = false;

  const append = (which, chunk) => {
    const text = chunk.toString('utf8');
    if (which === 'out') {
      if (stdout.length >= cap) { truncated = true; return; }
      stdout += text.slice(0, cap - stdout.length);
      if (stdout.length >= cap) truncated = true;
    } else {
      if (stderr.length >= cap) { truncated = true; return; }
      stderr += text.slice(0, cap - stderr.length);
      if (stderr.length >= cap) truncated = true;
    }
  };

  child.stdout.on('data', (c) => append('out', c));
  child.stderr.on('data', (c) => append('err', c));

  const timer = setTimeout(() => {
    timedOut = true;
    handle.stop('SIGTERM');
  }, timeoutMs);

  if (onCancelSignal) {
    onCancelSignal(() => {
      cancelled = true;
      handle.stop('SIGTERM');
    });
  }

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, truncated, timedOut, cancelled, ...payload });
    };
    child.on('error', (err) => finish({ code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });

  if (input !== undefined && input !== null) {
    child.stdin.on('error', () => { /* child may exit before draining stdin */ });
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }

  return { handle, done, pid: child.pid };
}
