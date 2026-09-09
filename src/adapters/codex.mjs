// Codex CLI adapter.
//
// Isolation applied here, not left to the parent's configuration:
//   --ignore-user-config  ~/.codex/config.toml is not read, so the user's MCP
//                         servers (peer-consult included) and plugins never
//                         load in the consultant -- this is the recursion barrier.
//   --ignore-rules        no user/project execpolicy rules.
//   -s read-only          verified: writes blocked, network from the shell
//                         blocked, so the consultant cannot edit or execute.
//   hooks.enabled=false   no hook inheritance.
//   shell_environment_policy.inherit="none"  child shell gets no parent env.
//   --ephemeral           the brief is not persisted into the user's session store.
//   tools.web_search=true search/browse stays available (server-side tool).

import path from 'node:path';
import { POLICY } from '../policy.mjs';
import { classifyMessage } from '../failures.mjs';

export const FORBIDDEN_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--add-dir',
  '--approve-for-me',
];

export function buildInvocation({ workdir, schemaPath }) {
  const t = POLICY.targets.codex;
  const lastMessagePath = path.join(workdir, '..', 'last-message.json');
  const args = [
    'exec',
    '--json',
    '--color', 'never',
    '-m', t.model,
    '-c', `model_reasoning_effort="${t.reasoningEffort}"`,
    '-c', 'tools.web_search=true',
    '-c', 'hooks.enabled=false',
    '-c', 'shell_environment_policy.inherit="none"',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s', 'read-only',
    '-C', workdir,
    '--output-schema', schemaPath,
    '-o', lastMessagePath,
    '-',
  ];
  return { command: t.cli, args, lastMessagePath, model: t.model };
}

function walkUsage(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (node.usage && typeof node.usage === 'object') {
    const u = node.usage;
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === 'number') acc[k] = Math.max(acc[k] ?? 0, v);
    }
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') walkUsage(v, acc);
}

/** Parse the JSONL event stream `codex exec --json` writes to stdout. */
export function interpret({ stdout, stderr, code, lastMessageText }) {
  const events = [];
  for (const line of (stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { events.push(JSON.parse(t)); } catch { /* partial line */ }
  }

  const errorEvents = events.filter((e) => e.type === 'error' || e.type === 'turn.failed');
  const usage = {};
  for (const e of events) walkUsage(e, usage);

  let text = (lastMessageText || '').trim();
  if (!text) {
    // Fall back to the last assistant message carried in the event stream.
    for (let i = events.length - 1; i >= 0 && !text; i--) {
      const e = events[i];
      const item = e.item ?? e;
      const candidate =
        (item && item.type && String(item.type).includes('agent_message') && (item.text ?? item.message)) ||
        (e.type === 'item.completed' && item && (item.text ?? item.message)) ||
        null;
      if (typeof candidate === 'string' && candidate.trim()) text = candidate.trim();
    }
  }

  if (errorEvents.length) {
    const msg = errorEvents
      .map((e) => e.message ?? e.error?.message ?? JSON.stringify(e))
      .join(' | ');
    return { ok: false, failureKind: classifyMessage(msg), message: msg, usage, events: events.length };
  }
  if (!text) {
    const msg = (stderr || '').trim() || `codex exited with code ${code} and produced no final message`;
    return {
      ok: false,
      failureKind: code === 0 ? 'invalid_output' : classifyMessage(msg),
      message: msg,
      usage,
      events: events.length,
    };
  }
  return { ok: true, text, usage, events: events.length };
}

export function usageRecord(raw) {
  const u = raw ?? {};
  const pick = (...names) => {
    for (const n of names) if (typeof u[n] === 'number') return u[n];
    return null;
  };
  return {
    input_tokens: pick('input_tokens', 'prompt_tokens'),
    cached_input_tokens: pick('cached_input_tokens', 'cache_read_input_tokens'),
    output_tokens: pick('output_tokens', 'completion_tokens'),
    total_tokens: pick('total_tokens'),
    cost_usd: null, // Codex CLI does not report a cost; do not guess one.
    web_search_requests: null,
  };
}
