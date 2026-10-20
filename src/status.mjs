// `severally-mcp status`: what this machine has set up, read without starting a
// consultation, so it spends no quota. It says what it can see and no more: a
// CLI being registered and installed does not show it is logged in, and that is
// reported as not checked rather than as working.
import { POLICY, configProblem, configWarnings, unavailableReason, consultantAvailable, brokenConsultantNames, brokenConsultant } from './policy.mjs';
import { SEVERALLY_VERSION, staleInstall } from './server.mjs';
import { findCommand, execCommandSync } from './platform.mjs';

// How each client lists severally, plugin installs first. A command that exits 0
// and names severally counts as registered.
const CLIENTS = [
  { label: 'Claude Code', cmd: 'claude', checks: [['plugin', 'list'], ['mcp', 'get', 'severally']] },
  { label: 'Codex', cmd: 'codex', checks: [['plugin', 'list'], ['mcp', 'get', 'severally']] },
  { label: 'Antigravity', cmd: 'agy', checks: [['mcp', 'list']] },
  { label: 'OpenCode', cmd: 'opencode', checks: [['mcp', 'list']] },
];

function registration({ cmd, checks }) {
  if (!findCommand(cmd)) return 'not installed';
  for (const args of checks) {
    try {
      const out = execCommandSync(cmd, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (/severally/.test(out)) return 'registered';
    } catch { /* a non-zero exit is "not this way"; try the next */ }
  }
  return 'not registered';
}

export function status() {
  const lines = [`severally ${SEVERALLY_VERSION}`, ''];
  const problem = configProblem();
  lines.push(`config: ${problem ? `needs fixing, every consultation is refused until it is -- ${problem}` : 'ok'}`);
  for (const w of configWarnings()) lines.push(`  mistake (only that consultant or CLI is out of use): ${w}`);
  lines.push(`network: ${POLICY.network === 'off' ? 'off for every consultation (server.network)' : 'per request'}`, '');

  lines.push('consultants:');
  for (const c of POLICY.consultants) {
    lines.push(`  ${c.name}: ${c.cli}, ${c.model}  ${consultantAvailable(c) ? 'available' : `not available: ${unavailableReason(c)}`}`);
  }
  for (const name of brokenConsultantNames()) lines.push(`  ${name}: not available: ${brokenConsultant(name)}`);
  lines.push('');

  const stale = staleInstall();
  lines.push(stale
    ? `copies: ${Object.entries(stale.copies).map(([k, v]) => `${k} ${v}${stale.behind.includes(k) ? ' (behind)' : ''}`).join(', ')}\n  ${stale.fix}`
    : 'copies: every installed copy is this version', '');

  lines.push('clients:');
  for (const client of CLIENTS) lines.push(`  ${client.label.padEnd(12)} ${registration(client)}`);
  lines.push('', 'login: not checked -- an installed, registered CLI may still be logged out or out of quota; '
    + 'the first consultation is what shows it');
  process.stdout.write(`${lines.join('\n')}\n`);
  return problem ? 1 : 0;
}
