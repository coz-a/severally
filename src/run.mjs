// Child-process plumbing: sanitised environment, own process group, hard
// wall-clock timeout, cancellation, and output caps.

import { spawnCommand as spawn } from './platform.mjs';
import path from 'node:path';
import { POLICY } from './policy.mjs';

const DROP_EXACT = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'ANTHROPIC_LOG', 'NODE_OPTIONS']);
const DROP_PREFIX = ['CLAUDE_CODE_', 'SEVERALLY_', 'MCP_'];

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
/** @type {Record<string, string[]>} */
const TARGET_DROP_PREFIX = {
  codex: ['ANTHROPIC_', 'GEMINI_', 'GOOGLE_', 'AGY_', 'ANTIGRAVITY_', 'ZAI_'],
  'claude-code': ['OPENAI_', 'CODEX_', 'GEMINI_', 'GOOGLE_', 'AGY_', 'ANTIGRAVITY_', 'ZAI_'],
  antigravity: ['ANTHROPIC_', 'OPENAI_', 'CODEX_', 'AGY_', 'ANTIGRAVITY_', 'ZAI_'],
  // OPENCODE_ is dropped on purpose even though it is this consultant's own
  // prefix: whatever the hosting session exported (OPENCODE_CONFIG,
  // OPENCODE_CONFIG_CONTENT, OPENCODE_PERMISSION...) must not reach the
  // child, or it could override the sandbox's config. The sandbox re-adds
  // the two variables the consultant needs, after the drop. ZAI_ stays: it
  // is where the zai-coding-plan provider's API key travels.
  opencode: ['ANTHROPIC_', 'OPENAI_', 'CODEX_', 'GEMINI_', 'GOOGLE_', 'AGY_', 'ANTIGRAVITY_', 'OPENCODE_'],
};

// Exact names dropped for one target only (see the note above). Kept separate
// from DROP_EXACT so the two other consultants, whose isolation has been
// verified with these variables present, are not changed.
/** @type {Record<string, string[]>} */
const TARGET_DROP_EXACT = {
  antigravity: ['XDG_CONFIG_HOME'],
};

/**
 * Build the child environment. The parent's agent-session wiring (messaging
 * sockets, session ids, entrypoint markers) is removed, as are the other two
 * vendors' credentials -- each consultant keeps only its own; and a recursion
 * marker is added.
 * @param {string} target
 * @param {Record<string, string>} [extra]
 * @param {Record<string, string>} [operator]
 * @returns {Record<string, string>}
 */
export function childEnv(target, extra = {}, operator = {}) {
  const { dropPrefixes, dropExact } = dropRules(target);
  const keep = providerEnvNames(target);
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const key = process.platform === 'win32' ? k.toUpperCase() : k;
    if (dropExact.has(key)) continue;
    if (dropPrefixes.some((p) => key.startsWith(p))) continue;
    if (foreignSecret(target, key, keep)) continue;
    env[key] = v;
  }
  for (const [k, v] of Object.entries(operator)) env[process.platform === 'win32' ? k.toUpperCase() : k] = v;
  env.SEVERALLY_ACTIVE = '1';
  env.SEVERALLY_ROLE = 'consultant';
  env.SEVERALLY_TARGET = target;
  return { ...env, ...extra };
}

// Other services' credentials: no consultant needs them, and the Codex
// consultant's shell could read its own environment. Dropped for every
// consultant by shape -- cloud, VCS and registry prefixes, and any name that
// ends like a secret -- except names under the consultant's own vendor
// prefix, which is where its CLI's key travels. Unlike the rules above this is
// a default, not isolation: a name the operator sets in clis.<cli>.env (an
// OpenCode provider's {env:...} key, say) still reaches the consultant.
const SECRET_PREFIX = ['AWS_', 'AZURE_', 'GITHUB_', 'GH_', 'GITLAB_', 'NPM_', 'DOCKER_', 'HF_', 'SLACK_', 'STRIPE_', 'OP_'];
const SECRET_SUFFIX = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)$/i;
const SECRET_EXACT = new Set(['SSH_AUTH_SOCK', 'KUBECONFIG', 'DATABASE_URL']);
/** @type {Record<string, string[]>} */
const OWN_PREFIX = {
  codex: ['OPENAI_', 'CODEX_'],
  'claude-code': ['ANTHROPIC_'],
  antigravity: ['GEMINI_', 'GOOGLE_'],
  opencode: ['ZAI_'],
};

// Names the operator's OpenCode provider definitions read as "{env:NAME}":
// the consultant needs them, wherever they were exported.
/** @param {string} target */
function providerEnvNames(target) {
  // Only OpenCode's section carries provider definitions.
  const provider = JSON.stringify(target === 'opencode' ? POLICY.clis.opencode.provider : {});
  return new Set([...provider.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].flatMap(([, name]) => name ?? []));
}

/**
 * @param {string} target
 * @param {string} key
 * @param {Set<string>} keep
 */
function foreignSecret(target, key, keep) {
  if (keep.has(key) || (OWN_PREFIX[target] ?? []).some((p) => key.startsWith(p))) return false;
  const upper = key.toUpperCase();
  return SECRET_EXACT.has(upper) || SECRET_PREFIX.some((p) => upper.startsWith(p)) || SECRET_SUFFIX.test(key);
}

/** @param {string} target */
function dropRules(target) {
  return {
    dropPrefixes: [...DROP_PREFIX, ...(TARGET_DROP_PREFIX[target] ?? [])],
    dropExact: new Set([...DROP_EXACT, ...(TARGET_DROP_EXACT[target] ?? [])]),
  };
}

/**
 * Why the operator's per-target `env` (config.json) cannot be handed to this
 * consultant, or null. A variable the rules above strip -- session wiring,
 * severally's own markers, another vendor's credentials, a name that redirects
 * this CLI's configuration -- is stripped for isolation, so setting it back
 * by config is refused rather than honoured; so is any name the per-job
 * sandbox sets (HOME and friends), which would otherwise be silently
 * overwritten.
 * @param {string} target
 * @param {unknown} env
 * @param {string[]} [sandboxKeys]
 * @returns {string | null}
 */
export function operatorEnvProblem(target, env, sandboxKeys = []) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return 'must be an object of string values';
  const { dropPrefixes, dropExact } = dropRules(target);
  const fold = (/** @type {string} */ k) => (process.platform === 'win32' ? k.toUpperCase() : k);
  const reserved = new Set(sandboxKeys.map(fold));
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') return `${k} must be a string`;
    const key = fold(k);
    if (dropExact.has(key) || dropPrefixes.some((p) => key.startsWith(p)) || reserved.has(key)) {
      return `${k} is controlled by severally for this consultant's isolation and cannot be set`;
    }
  }
  return null;
}

export class ProcHandle {
  /**
   * @param {import('node:child_process').ChildProcess} child
   * @param {() => string} [readStdout]
   */
  constructor(child, readStdout = () => '') {
    this.child = child;
    this.killed = false;
    /** @type {(() => void) | undefined} */
    this.onStop = undefined;
    // What the child has written so far. A consultation runs for minutes, and
    // without this the only honest answer to "how is it going" is "running".
    this.stdoutSoFar = readStdout;
  }

  /**
   * Kill the child and every descendant it spawned -- also after the child
   * itself has exited: a descendant still holding its pipes keeps the
   * consultation from closing, and on POSIX it is still in the group.
   * @param {NodeJS.Signals} [signal]
   */
  stop(signal = 'SIGTERM') {
    if (this.killed || !this.child) return;
    this.killed = true;
    this.onStop?.();
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      // Negative PIDs/process groups are POSIX-only. Kill the Windows tree
      // before its parent exits and its descendants become unreachable. Once
      // it has exited, its pid may already be another process's: leave it.
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      const killer = spawn(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      const fallback = () => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      };
      killer.on('error', fallback);
      killer.on('exit', (code) => {
        if (code !== 0) fallback();
      });
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        /* gone */
      }
    }
    setTimeout(() => this.forceKill(), POLICY.killGraceMs).unref();
  }

  /**
   * SIGKILL the whole process group now, whether or not stop() already ran
   * and whether or not the leader has exited: a descendant that ignored
   * SIGTERM outlives its parent. The unref'd timer above never fires once the
   * server exits, so shutdown calls this itself. On Windows stop() already
   * ran taskkill /T /F, which is as forceful as it gets there.
   */
  forceKill() {
    const pid = this.child?.pid;
    if (!pid || process.platform === 'win32') return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/**
 * @typedef {object} ChildResult
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} truncated
 * @property {boolean} timedOut
 * @property {boolean} cancelled
 * @property {boolean} stalled
 * @property {boolean} pipesForced
 * @property {string} [spawnError]
 */

/**
 * What an adapter's buildInvocation returns.
 * @typedef {object} Invocation
 * @property {string} command
 * @property {string[]} args
 * @property {string} model
 * @property {string} [workdir]
 * @property {string} [lastMessagePath]
 */

/**
 * The synthesised HOME of one consultation, as an adapter's prepareSandbox
 * returns it; what the adapters share of it.
 * @typedef {object} Sandbox
 * @property {string} root
 * @property {string} credentials 'symlink', 'copy' or 'missing'
 * @property {string} credentialsSource
 * @property {readonly string[]} tools
 * @property {Record<string, string>} env
 * @property {() => void} cleanup
 * @property {(provider: string) => boolean} [seed] insert the provider's credential into the session database (OpenCode only)
 */

/**
 * What a consultant was launched with, read off the invocation: the boundary
 * record kept beside each answer. Facts about the launch, not a claim about
 * what the consultant did.
 * @typedef {object} Boundary
 * @property {string} reads
 * @property {string} shell
 * @property {boolean} web
 * @property {boolean} writes
 * @property {boolean} mcp
 * @property {string} protected_paths
 * @property {string[] | null} tools
 */

/**
 * What a consultation used, as far as its CLI says; null where it does not say.
 * @typedef {object} UsageRecord
 * @property {number | null} input_tokens
 * @property {number | null} cached_input_tokens
 * @property {number | null} output_tokens
 * @property {number | null} total_tokens
 * @property {number | null} cost_usd
 * @property {number | null} web_search_requests
 * @property {number | null} [turns]
 * @property {number | null} [thinking_tokens]
 * @property {number | null} [reasoning_tokens]
 * @property {string[] | null} [denied_actions]
 */

/**
 * What jobs.mjs hands buildInvocation; each adapter reads the fields it needs.
 * @typedef {object} BuildRequest
 * @property {string} workdir
 * @property {string} schemaPath
 * @property {string} guardrails
 * @property {Sandbox | null} sandbox the adapter's own prepareSandbox result, if it has one
 * @property {import('./consultants.mjs').Consultant} consultant
 * @property {boolean} [hasExposedPaths]
 * @property {'on' | 'off' | undefined} [network]
 */

/**
 * What an adapter's interpret makes of a finished child: an answer (text is a
 * JSON object or the raw text to mine one out of), or a classified failure.
 * @typedef {{ ok: true, text: string | Record<string, unknown>, usageRaw: unknown, payload?: unknown, events?: number, denials?: unknown[], recoveredError?: { failureKind: string, message: string } | null, earlierTextParts?: string[] }} InterpretedOk
 * @typedef {{ ok: false, failureKind: string, message: string, usageRaw: unknown, payload?: unknown, events?: number }} InterpretedFail
 * @typedef {InterpretedOk | InterpretedFail} Interpreted
 */

/**
 * The shape every adapter module (codex, claude-code, antigravity, opencode)
 * exports; the optional members are the ones only some CLIs have.
 * @typedef {object} Adapter
 * @property {readonly string[]} FORBIDDEN_FLAGS
 * @property {readonly string[]} RESERVED_FLAGS
 * @property {(req: BuildRequest) => Invocation} buildInvocation
 * @property {(run: Partial<ChildResult> & { lastMessageText?: string }) => Interpreted} interpret
 * @property {(raw: unknown) => UsageRecord | null} usageRecord
 * @property {(args: { args: string[], sandbox: Sandbox | null, network?: 'on' | 'off' | undefined, hasExposedPaths?: boolean }) => Boundary} [boundary]
 * @property {(run: { stdout: string }) => string | null} [progress]
 * @property {(run: { stdout: string }) => Record<string, number> | null} [toolCalls]
 * @property {(run: { stdout: string }) => string[]} [toolInputs] the commands or paths its tool calls were given
 * @property {readonly string[]} [FILE_READ_TOOLS] the names toolCalls reports for reading a file
 * @property {readonly string[]} [ALLOWED_TOOLS] the only tools the consultant may call; any other is refused
 * @property {() => Promise<void>} [prepare]
 * @property {(args: { workdir: string, network?: 'on' | 'off' | undefined }) => Sandbox} [prepareSandbox]
 * @property {(args: { run: ChildResult, sandbox: Sandbox }) => string} [diagnostics]
 * @property {(args: { interpreted: Interpreted, sandbox: Sandbox, model: string }) => boolean} [recoverAuthFailure]
 * @property {(line: string) => string} [compactLine]
 * @property {(line: string) => number | null | undefined} [settleAfter]
 * @property {NodeJS.Signals} [stopSignal]
 */

/**
 * `pipesForced` in the result: the child exited but something it started kept
 * stdout or stderr open past the kill grace, so stopping was attempted and the
 * pipes closed from this side. A descendant outside the group (setsid, or on
 * Windows once the parent is gone) may still be running.
 * @param {object} options
 * @param {string} options.command
 * @param {readonly string[]} options.args
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string | null} [options.input]
 * @param {number} options.timeoutMs
 * @param {(cancel: () => void) => void} [options.onCancelSignal]
 * @param {((line: string) => string) | null} [options.compactLine]
 * @param {((line: string) => number | null | undefined) | null} [options.settleAfter]
 * @param {((line: string) => void) | null} [options.onOutputLine]
 * @param {NodeJS.Signals} [options.stopSignal]
 * @returns {{handle: ProcHandle, done: Promise<ChildResult>, pid: number | undefined}}
 */
export function runChild({
  command,
  args,
  cwd,
  env,
  input,
  timeoutMs,
  onCancelSignal,
  compactLine = null,
  settleAfter = null,
  onOutputLine = null,
  stopSignal = 'SIGTERM',
}) {
  const child = spawn(command, args, {
    cwd,
    // PWD is the parent's otherwise, and opencode takes its project root from
    // it: on 2026-10-17 a consultant globbed the lead's own directory. Every
    // consultant gets its working directory as PWD, never where the server runs.
    env: env && cwd ? { ...env, PWD: cwd } : env,
    detached: process.platform !== 'win32', // POSIX process group; Windows uses taskkill /T
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const cap = POLICY.output.rawCaptureMax;

  let stdout = '';
  const handle = new ProcHandle(child, () => stdout);
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  let cancelled = false;
  // settleAfter(line) gives how long the child may stay alive after a line that
  // says it is done; past that it is stopped and `stalled` set. A later line
  // can shorten the wait, never lengthen it.
  let stalled = false;
  /** @type {NodeJS.Timeout | undefined} */
  let settleTimer;
  let settleAt = Infinity;
  const watch = (/** @type {string} */ line) => {
    const ms = settleAfter?.(line);
    if (ms == null || Date.now() + ms >= settleAt) return;
    settleAt = Date.now() + ms;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      stalled = true;
      handle.stop(stopSignal);
    }, ms);
  };

  const append = (/** @type {'out' | 'err'} */ which, /** @type {string | Buffer} */ chunk) => {
    const text = chunk.toString('utf8');
    if (which === 'out') {
      if (stdout.length >= cap) {
        truncated = true;
        return;
      }
      stdout += text.slice(0, cap - stdout.length);
      if (stdout.length >= cap) truncated = true;
    } else {
      if (stderr.length >= cap) {
        truncated = true;
        return;
      }
      stderr += text.slice(0, cap - stderr.length);
      if (stderr.length >= cap) truncated = true;
    }
  };

  // With compactLine, stdout is captured a whole line at a time so the adapter
  // can shrink each event before it counts against the cap. The pending
  // partial line is bounded by the cap too; past it, the line is kept as is.
  let pending = '';
  const byLine = Boolean(compactLine || settleAfter || onOutputLine);
  const compact = compactLine ?? ((/** @type {string} */ l) => l);
  const flushLines = () => {
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const l of lines) {
      if (settleAfter) watch(l);
      onOutputLine?.(l);
      append('out', `${compact(l)}\n`);
    }
    if (pending.length > cap) {
      append('out', pending);
      pending = '';
    }
  };
  // Decode as a stream: a multibyte character split across two chunks would
  // otherwise turn into replacement characters inside the answer text.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    if (!byLine) return append('out', c);
    pending += c;
    flushLines();
  });
  child.stderr.on('data', (c) => append('err', c));

  const timer = setTimeout(() => {
    timedOut = true;
    handle.stop(stopSignal);
  }, timeoutMs);

  /** @type {Promise<ChildResult>} */
  const done = new Promise((resolve) => {
    let settled = false;
    let pipesForced = false;
    /** @type {NodeJS.Timeout | undefined} */
    let orphanTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let stopTimer;
    /** @type {{code: number | null, signal: NodeJS.Signals | null} | undefined} */
    let exitInfo;
    let stopGraceElapsed = false;
    const finish = (/** @type {{ code: number | null, signal: NodeJS.Signals | null, spawnError?: string }} */ payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      clearTimeout(orphanTimer);
      clearTimeout(stopTimer);
      handle.onStop = undefined;
      resolve({ stdout, stderr, truncated, timedOut, cancelled, stalled, pipesForced, ...payload });
    };
    const flushPending = () => {
      if (byLine && pending) {
        append('out', compact(pending));
        pending = '';
      }
    };
    const closeOrphanPipes = () => {
      if (!exitInfo || settled) return;
      pipesForced = true;
      handle.forceKill();
      flushPending();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(exitInfo);
    };
    // Once a stop has been requested, do not wait two further grace periods
    // for descendants that inherited pipes. Do not report completion while
    // the direct child is still alive: force it and await its exit first.
    handle.onStop = () => {
      stopTimer = setTimeout(() => {
        stopGraceElapsed = true;
        handle.forceKill();
        closeOrphanPipes();
      }, POLICY.killGraceMs);
    };
    child.on('error', (err) => finish({ code: null, signal: null, spawnError: err.message }));
    // 'close' waits for the pipes as well as the child. Once the child has
    // exited, a grace later the rest of its group is stopped, and a grace
    // after that the pipes are closed from here, whoever still holds them.
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (stopGraceElapsed) {
        closeOrphanPipes();
        return;
      }
      const grace = POLICY.killGraceMs;
      orphanTimer = setTimeout(() => {
        pipesForced = true;
        handle.stop(stopSignal);
        orphanTimer = setTimeout(() => {
          handle.forceKill();
          flushPending();
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code, signal });
        }, grace);
      }, grace);
    });
    child.on('close', (code, signal) => {
      flushPending();
      // A descendant that let go of the pipes is still in the group once the
      // child is done; it is stopped too, rather than left running.
      handle.stop(stopSignal);
      finish({ code, signal });
    });
  });

  if (onCancelSignal) {
    onCancelSignal(() => {
      cancelled = true;
      handle.stop(stopSignal);
    });
  }

  if (input !== undefined && input !== null) {
    child.stdin.on('error', () => {
      /* child may exit before draining stdin */
    });
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }

  return { handle, done, pid: child.pid };
}
