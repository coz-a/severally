// `severally-mcp status`: what this machine has set up, read without starting a
// consultation, so it spends no quota. It says what it can see and no more:
// login is read from each CLI's own status command where it has one, and where
// it has none it is reported as not checked rather than as working.
import path from 'node:path';
import {
  POLICY,
  configProblem,
  configWarnings,
  unavailableReason,
  consultantAvailable,
  brokenConsultantNames,
  brokenConsultant,
  timeoutMs,
  opencodeCredentialsHome,
} from './policy.mjs';
import { SEVERALLY_VERSION, staleInstall } from './server.mjs';
import { findCommand } from './platform.mjs';
import { launchProblem as codexPlacementWarning } from './adapters/codex.mjs';
import { credentialRecoveryStatus } from './adapters/opencode-sandbox.mjs';
import { childEnv, operatorEnvProblem, runChild } from './run.mjs';

const PROBE_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 20_000;

// How each client lists severally, plugin installs first. A command that exits 0
// and names severally counts as registered.
const CLIENTS = [
  {
    label: 'Claude Code',
    cmd: 'claude',
    checks: [
      ['plugin', 'list'],
      ['mcp', 'get', 'severally'],
    ],
  },
  {
    label: 'Codex',
    cmd: 'codex',
    checks: [
      ['plugin', 'list'],
      ['mcp', 'get', 'severally'],
    ],
  },
  { label: 'Antigravity', cmd: 'agy', checks: [['mcp', 'list']] },
  { label: 'OpenCode', cmd: 'opencode', checks: [['mcp', 'list']] },
];

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {number} deadline
 */
async function probe(command, args, env, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { problem: 'status time budget exhausted' };
  try {
    const { done } = runChild({
      command,
      args,
      env,
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining),
    });
    const result = await done;
    if (result.timedOut) return { problem: 'timed out; run the CLI status command directly' };
    if (result.spawnError || result.signal || result.pipesForced || result.truncated) {
      return { problem: 'probe failed; run the CLI status command directly' };
    }
    return { result };
  } catch {
    return { problem: 'probe failed; check the executable and run its status command directly' };
  }
}

// "registered": the client's own listing names severally (it may still be
// turned off there). "not registered": the client answered, without it.
// No answer at all (a timeout, a failure to start): unknown.
/**
 * @param {{ cmd: string, checks: string[][] }} client
 * @param {number} deadline
 */
async function registration({ cmd, checks }, deadline) {
  if (!findCommand(cmd)) return 'not installed';
  let ran = false;
  for (const args of checks) {
    const check = await probe(cmd, args, process.env, deadline);
    if (check.result?.code === 0) {
      ran = true;
      if (/(^|[\s@:])severally([\s@:]|$)/m.test(check.result.stdout)) return 'registered (listed by the client)';
    } else {
      // It ran and said no (`mcp get` of a missing server exits non-zero); a
      // timeout or a failure to start says nothing either way.
      if (typeof check.result?.code === 'number') ran = true;
    }
  }
  return ran ? 'not registered' : `could not tell (${cmd} ${checks.map((a) => a.join(' ')).join(' / ')} failed)`;
}

// Each CLI's own word on its login, read without sending a prompt. Only the
// verdict is kept: `claude auth status` also prints the account's email.
// Antigravity has no such command, so it is not checked.
/** @type {Partial<Record<import('./consultants.mjs').CliId, { args: string[], read: (out: string, ok: boolean, stderr: string) => boolean | string }>>} */
const LOGIN = {
  'claude-code': {
    args: ['auth', 'status', '--json'],
    read: (out) => {
      const parsed = JSON.parse(out);
      if (typeof parsed.loggedIn !== 'boolean') throw new Error('unsupported response');
      return parsed.loggedIn;
    },
  },
  // Codex prints its answer on stderr; the exit status carries the verdict.
  codex: {
    args: ['login', 'status'],
    read: (out, ok, stderr) => {
      if (ok) return true;
      if (/\bnot logged in\b/i.test(`${out}\n${stderr}`)) return false;
      throw new Error('unsupported response');
    },
  },
  // OpenCode can also take keys from the environment, so no saved credential
  // is a warning, not a verdict.
  opencode: {
    args: ['auth', 'list'],
    read: (out) => {
      const n = out.split('\n').filter((l) => /\bstored\b/.test(l)).length;
      return n ? `${n} saved credential${n > 1 ? 's' : ''}` : 'no saved credentials (keys in the environment still work)';
    },
  },
};

/**
 * @param {import('./consultants.mjs').CliId} cli
 * @param {number} deadline
 */
async function login(cli, deadline) {
  const check = LOGIN[cli];
  if (!check) return 'not checked (no login status command)';
  const configured = POLICY.clis[cli];
  const problem = operatorEnvProblem(cli, configured.extraEnv);
  if (problem) return `not checked (clis.${cli}.env needs fixing: ${problem})`;
  const env = childEnv(cli, {}, configured.extraEnv);
  if (cli === 'opencode') {
    // The consultation copies auth.json from this root, independently of the
    // host's XDG lookup. Point the login probe at that same credential source.
    env.XDG_DATA_HOME = path.join(opencodeCredentialsHome(), '.local', 'share');
  }
  const command = findCommand(configured.cli, { env });
  if (!command) return 'not installed (configured executable; check clis bin or PATH)';
  if (!configured.available) return 'not checked (CLI disabled in configuration)';
  const response = await probe(command, check.args, env, deadline);
  if (!response.result) return `could not tell (${response.problem})`;
  const { stdout, stderr, code } = response.result;
  try {
    if (cli === 'opencode' && code !== 0) throw new Error('unsupported response');
    const v = check.read(stdout, code === 0, stderr);
    return v === true ? 'logged in' : v || 'not logged in';
  } catch {
    return `could not tell (${check.args.join(' ')} unsupported or answered unexpectedly; update the CLI or check it directly)`;
  }
}

/** @param {import('./consultants.mjs').Consultant} consultant */
function effectiveEffort(consultant) {
  if (consultant.cli === 'antigravity') return 'in model name';
  if (consultant.cli === 'opencode' && consultant.model.includes('#')) {
    const variant = consultant.model.slice(consultant.model.indexOf('#') + 1);
    return variant || 'no variant';
  }
  return consultant.effort ?? 'high';
}

export async function status() {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  const loginClis = [...new Set(POLICY.consultants.map((c) => c.cli))];
  const registrations = CLIENTS.map((client) => registration(client, deadline));
  const logins = loginClis.map((cli) => login(cli, deadline));
  const lines = [`severally ${SEVERALLY_VERSION}`, ''];
  const problem = configProblem();
  lines.push(`config: ${problem ? `needs fixing, every consultation is refused until it is -- ${problem}` : 'ok'}`);
  for (const w of configWarnings()) lines.push(`  mistake (only that consultant or CLI is out of use): ${w}`);
  lines.push(`network: ${POLICY.network === 'off' ? 'off for every consultation (server.network)' : 'per request'}`, '');
  const placementWarning = codexPlacementWarning();
  if (placementWarning) lines.push(`warning: ${placementWarning}`, '');
  lines.push(`OpenCode credential recovery: ${credentialRecoveryStatus().detail}`, '');

  lines.push(
    'consultants:',
    '  availability means the CLI is enabled and found; login, quota and live consultation are not verified by it.',
  );
  for (const c of POLICY.consultants) {
    lines.push(
      `  ${c.name}: ${c.cli}, ${c.model}  ${consultantAvailable(c) ? 'available' : `not available: ${unavailableReason(c)}`} (effort: ${effectiveEffort(c)}, timeout: ${timeoutMs(c)} ms)`,
    );
  }
  for (const name of brokenConsultantNames()) lines.push(`  ${name}: not available: ${brokenConsultant(name)}`);
  lines.push('');

  const stale = staleInstall();
  lines.push(
    stale
      ? `copies: ${Object.entries(stale.copies)
          .map(([k, v]) => `${k} ${v}${stale.behind.includes(k) ? ' (behind)' : ''}`)
          .join(', ')}\n  ${stale.fix}`
      : 'copies: every installed copy is this version',
    '',
  );

  lines.push('clients:');
  const registered = await Promise.all(registrations);
  for (const [i, client] of CLIENTS.entries()) lines.push(`  ${client.label.padEnd(12)} ${registered[i]}`);
  lines.push('', 'login (out of quota is not checked; the first consultation shows it):');
  const loggedIn = await Promise.all(logins);
  for (const [i, cli] of loginClis.entries()) lines.push(`  ${cli.padEnd(12)} ${loggedIn[i]}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return problem ? 1 : 0;
}
