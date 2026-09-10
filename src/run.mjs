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
//
// The antigravity row is also the consultant's *only* isolation boundary
// besides the synthesised HOME: Codex and Claude Code hold theirs in flags
// (--ignore-user-config, --restricted --strict-mcp-config) that the
// environment cannot undo, while agy has no such flag -- everything comes
// from ~/.gemini, so a variable that redirected that lookup would silently
// bypass the empty mcp_config.json and the deny rules while the job still
// succeeded. What was checked against agy 1.1.28 on Linux, and concluded:
//
//   XDG_CONFIG_HOME  Appears in the binary (5 times), but does not redirect
//     config discovery. Probed directly: with HOME=<sandbox> holding an
//     mcp_config.json that declares a sentinel server, `agy mcp list` reports
//     that sentinel both with and without XDG_CONFIG_HOME pointed at an empty
//     directory; and with the real HOME plus XDG_CONFIG_HOME pointed at the
//     sandbox's .gemini, agy reports "No MCP servers configured". HOME alone
//     decides. Dropped regardless: it costs nothing, and the whole isolation
//     hangs on one variable.
//   AGY_*  Mostly feature flags and telemetry event names (AGY_CLI_HIDE_LOGO,
//     AGY_CLI_DISABLE_LATEX, AGY_ONBOARDING_*, AGY_BUSINESS_PAYGO_TIER), none
//     of which names a config or data directory -- but the prefix is not
//     credential-free: AGY_ADC_AUTH reads as an auth-mode toggle for the same
//     ADC path GOOGLE_APPLICATION_CREDENTIALS is kept for. Dropped as a class
//     anyway, since the ADC credential itself travels under GOOGLE_*; an
//     operator who turns out to need that toggle will see `kind: auth`, not a
//     silently widened consultant.
//   ANTIGRAVITY_*  Does include names that point at state --
//     ANTIGRAVITY_EXECUTABLE_DATA_DIR, ANTIGRAVITY_PROJECT_ID,
//     ANTIGRAVITY_SIDECAR_*. Dropped as a class.
//   GEMINI_* / GOOGLE_*  Kept: this is where an API-key credential lives
//     (GEMINI_API_KEY, GOOGLE_API_KEY and GOOGLE_APPLICATION_CREDENTIALS all
//     appear in the binary), and dropping them would break an operator who
//     authenticates that way rather than with the OAuth token the sandbox
//     links.
//
// The names came out of the binary with `strings`; only XDG_CONFIG_HOME was
// probed behaviourally, so read the AGY_* line as "no evidence of a
// config-dir override under that prefix", not as proof that none exists.
const TARGET_DROP_PREFIX = {
  codex: ['ANTHROPIC_', 'GEMINI_', 'GOOGLE_', 'AGY_', 'ANTIGRAVITY_'],
  'claude-code': ['OPENAI_', 'CODEX_', 'GEMINI_', 'GOOGLE_', 'AGY_', 'ANTIGRAVITY_'],
  antigravity: ['ANTHROPIC_', 'OPENAI_', 'CODEX_', 'AGY_', 'ANTIGRAVITY_'],
};

// Exact names dropped for one target only (see the note above). Kept separate
// from DROP_EXACT so the two other consultants, whose isolation has been
// verified with these variables present, are not changed.
const TARGET_DROP_EXACT = {
  antigravity: ['XDG_CONFIG_HOME'],
};

/**
 * Build the child environment. The parent's agent-session wiring (messaging
 * sockets, session ids, entrypoint markers) is removed, as are the other two
 * vendors' credentials -- each consultant keeps only its own; and a recursion
 * marker is added.
 */
export function childEnv(target, extra = {}) {
  const dropPrefixes = [...DROP_PREFIX, ...(TARGET_DROP_PREFIX[target] ?? [])];
  const dropExact = new Set([...DROP_EXACT, ...(TARGET_DROP_EXACT[target] ?? [])]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (dropExact.has(k)) continue;
    if (dropPrefixes.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.PEER_CONSULT_ACTIVE = '1';
  env.PEER_CONSULT_ROLE = 'consultant';
  env.PEER_CONSULT_TARGET = target;
  return { ...env, ...extra };
}

export class ProcHandle {
  constructor(child, readStdout = () => '') {
    this.child = child;
    this.killed = false;
    // What the child has written so far. A consultation runs for minutes, and
    // without this the only honest answer to "how is it going" is "running".
    this.stdoutSoFar = readStdout;
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
  const cap = POLICY.output.rawCaptureMax;

  let stdout = '';
  const handle = new ProcHandle(child, () => stdout);
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
