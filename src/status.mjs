// `severally-mcp status`: what this machine has set up, read without starting a
// consultation, so it spends no quota. It says what it can see and no more:
// login is read from each CLI's own status command where it has one, and where
// it has none it is reported as not checked rather than as working.
import fs from 'node:fs';
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
  protectedRoots,
} from './policy.mjs';
import { SEVERALLY_VERSION, staleInstall } from './server.mjs';
import { findCommand, execCommandSync } from './platform.mjs';
import { credentialRecoveryStatus } from './adapters/opencode-sandbox.mjs';

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
 * A field of whatever was thrown, or undefined when it carries none.
 * @param {unknown} e
 * @param {string} key
 * @returns {unknown}
 */
const thrown = (e, key) => (typeof e === 'object' && e !== null ? Reflect.get(e, key) : undefined);

// "registered": the client's own listing names severally (it may still be
// turned off there). "not registered": the client answered, without it.
// No answer at all (a timeout, a failure to start): unknown.
/** @param {{ cmd: string, checks: string[][] }} client */
function registration({ cmd, checks }) {
  if (!findCommand(cmd)) return 'not installed';
  let ran = false;
  for (const args of checks) {
    try {
      const out = execCommandSync(cmd, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
      ran = true;
      if (/(^|[\s@:])severally([\s@:]|$)/m.test(out)) return 'registered (listed by the client)';
    } catch (err) {
      // It ran and said no (`mcp get` of a missing server exits non-zero); a
      // timeout or a failure to start says nothing either way.
      if (typeof thrown(err, 'status') === 'number') ran = true;
    }
  }
  return ran ? 'not registered' : `could not tell (${cmd} ${checks.map((a) => a.join(' ')).join(' / ')} failed)`;
}

// Each CLI's own word on its login, read without sending a prompt. Only the
// verdict is kept: `claude auth status` also prints the account's email.
// Antigravity has no such command, so it is not checked.
/** @type {Record<string, { cmd: string, args: string[], read: (out: string, ok: boolean) => boolean | string }>} */
const LOGIN = {
  'claude-code': { cmd: 'claude', args: ['auth', 'status', '--json'], read: (out) => JSON.parse(out).loggedIn === true },
  // Codex prints its answer on stderr; the exit status carries the verdict.
  codex: { cmd: 'codex', args: ['login', 'status'], read: (out, ok) => ok },
  // OpenCode can also take keys from the environment, so no saved credential
  // is a warning, not a verdict.
  opencode: {
    cmd: 'opencode',
    args: ['auth', 'list'],
    read: (out) => {
      const n = out.split('\n').filter((l) => /\bstored\b/.test(l)).length;
      return n ? `${n} saved credential${n > 1 ? 's' : ''}` : 'no saved credentials (keys in the environment still work)';
    },
  },
};

/** @param {string} cli */
function login(cli) {
  const check = LOGIN[cli];
  if (!check) return 'not checked (no login status command)';
  if (!findCommand(check.cmd)) return 'not installed';
  /** @type {string} */
  let out;
  let ok = true;
  try {
    out = execCommandSync(check.cmd, check.args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (typeof thrown(e, 'status') !== 'number') return `could not tell (${check.cmd} ${check.args.join(' ')} failed)`;
    out = `${thrown(e, 'stdout') ?? ''}`;
    ok = false;
  }
  try {
    const v = check.read(out, ok);
    return v === true ? 'logged in' : v || 'not logged in';
  } catch {
    return `could not tell (${check.cmd} ${check.args.join(' ')} answered in an unexpected form)`;
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

// Match the adapter's canonical root and executable comparison without creating
// a sandbox or treating this configuration check as proof of effective denial.
function codexPlacementWarning() {
  const command = findCommand(POLICY.clis.codex.cli);
  if (!command) return null;
  let executable;
  try {
    executable = fs.realpathSync.native(command);
  } catch {
    return 'Codex executable placement could not be resolved; check it against protected credential roots.';
  }
  for (const root of protectedRoots()) {
    if (root.includes('*')) continue;
    let canonical;
    try {
      canonical = fs.realpathSync.native(root);
    } catch {
      continue;
    }
    const relative = path.relative(canonical, executable);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return 'Codex executable is inside a protected root; new files there may be readable. Move the executable outside credential roots and verify PATH.';
    }
  }
  return null;
}

export function status() {
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
  for (const client of CLIENTS) lines.push(`  ${client.label.padEnd(12)} ${registration(client)}`);
  lines.push('', 'login (out of quota is not checked; the first consultation shows it):');
  for (const cli of [...new Set(POLICY.consultants.map((c) => c.cli))]) lines.push(`  ${cli.padEnd(12)} ${login(cli)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return problem ? 1 : 0;
}
