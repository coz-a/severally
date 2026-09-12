// Claude Code CLI adapter.
//
// Isolation applied here, not left to the parent's configuration:
//   --restricted            drops the command/code-running tools, ignores user,
//                           project and local settings files (so no inherited
//                           hooks/permissions), refuses bypassPermissions.
//   --tools WebSearch,WebFetch,Read,Glob,Grep  the only tools provisioned.
//                           Read/Glob/Grep are there so that all three
//                           consultants are equal readers -- Codex's sandbox is
//                           read-only rather than execution-free, and a fan-out
//                           whose members can read different amounts is not a
//                           fan-out. --restricted still drops every tool that
//                           runs commands or code, so there is no Write, Edit
//                           or Bash: verified by reading a file in the child.
//   --strict-mcp-config     with no --mcp-config, zero MCP servers load, so the
//                           peer-consult server is not reachable: recursion barrier.
//   --setting-sources ''    belt and braces over --restricted.
//   --disable-slash-commands  no skills, so the peer-consult skill cannot fire.
//   --permission-prompts none  anything that would prompt is denied outright.
//   --no-session-persistence   the brief is not written to the user's session store.

import { POLICY } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';
import { CONSULT_RESULT_SCHEMA } from '../result-schema.mjs';

export const FORBIDDEN_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--add-dir',
  '--mcp-config',
  '--plugin-dir',
  '--plugin-url',
];

export function buildInvocation({ workdir, guardrails, model }) {
  const t = POLICY.targets['claude-code'];
  const chosen = model ?? t.model;
  const args = [
    '-p',
    '--model', chosen,
    '--restricted',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--tools', 'WebSearch,WebFetch,Read,Glob,Grep',
    '--permission-prompts', 'none',
    '--permission-mode', 'manual',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(CONSULT_RESULT_SCHEMA),
    '--max-budget-usd', String(t.maxBudgetUsd),
    '--append-system-prompt', guardrails,
  ];
  return { command: t.cli, args, model: chosen, workdir };
}

function lastJsonObject(stdout) {
  const lines = (stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* not the result line */ }
  }
  return null;
}

export function interpret({ stdout, stderr, code }) {
  const payload = lastJsonObject(stdout);
  if (!payload) {
    const msg = (stderr || '').trim() || (stdout || '').trim().slice(0, 2000) ||
      `claude exited with code ${code} and produced no JSON result`;
    return { ok: false, failureKind: code === 0 ? 'invalid_output' : classifyMessage(msg), message: msg, payload: null, usageRaw: null };
  }
  if (payload.is_error) {
    const msg = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload).slice(0, 2000);
    return { ok: false, failureKind: classifyMessage(msg), message: msg, payload, usageRaw: payload };
  }
  const structured = payload.structured_output ?? payload.structuredOutput ?? null;
  const text = structured ?? (typeof payload.result === 'string' ? payload.result : null);
  if (!text) {
    return { ok: false, failureKind: 'invalid_output', message: 'result payload contained no answer', payload, usageRaw: payload };
  }
  return { ok: true, text, payload, usageRaw: payload, denials: payload.permission_denials ?? [] };
}

export function usageRecord(payload) {
  if (!payload) return null;
  const u = payload.usage ?? {};
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(u.cache_read_input_tokens),
    output_tokens: num(u.output_tokens),
    total_tokens: null,
    cost_usd: num(payload.total_cost_usd),
    web_search_requests: num(u.server_tool_use?.web_search_requests),
    turns: num(payload.num_turns),
  };
}
