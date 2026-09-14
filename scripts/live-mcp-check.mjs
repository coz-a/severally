#!/usr/bin/env node
// Full-stack verification: drives the *installed* MCP server the way a client
// does, runs a real consultation, a real follow-up round, and a real cancel,
// then prints the history. Spends real quota.
//
//   node scripts/live-mcp-check.mjs
//   SEVERALLY_CLAUDE_MODEL=claude-haiku-4-5-20251001 node scripts/live-mcp-check.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';

// The globally installed server, unless another path is given.
const BIN = process.argv[2] ?? 'severally-mcp';
const env = { ...process.env };
const client = new Client({ name: 'live-mcp', version: '1' });
await client.connect(new StdioClientTransport({ command: BIN, args: [], env }));
const P = (r) => JSON.parse(r.content[0].text);

const request = {
  target: 'claude-code',
  mode: 'debate',
  question: 'Should job ids be UUIDv4 or a short random hex string?',
  objective: 'Pick an id format for background jobs surfaced to another agent over MCP.',
  success_criteria: ['A recommendation with the condition that would flip it'],
  constraints: ['Ids appear in tool arguments typed by a model', 'At most a few hundred jobs per session'],
  context: {
    facts: ['Ids are never used as database keys.', 'Collisions inside one session would be a correctness bug.'],
    proposal: 'Short 12-char hex, because a model retyping a UUID into a follow-up tool call is more error-prone.',
    counterpoints: ['UUIDv4 is standard and the collision analysis is already done for you.'],
  },
  followup_to: null,
};

console.log('--- 1. real consultation over MCP (target=claude-code) ---');
const started = P(await client.callTool({ name: 'consult_start', arguments: { request } }));
console.log('job:', started.job_id, '| model:', started.model, '| round:', started.round);
const t0 = Date.now();
let view = P(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 40000 } }));
while (view.status === 'running') {
  view = P(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 40000 } }));
}
console.log(`status=${view.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (view.status === 'completed') {
  console.log('summary:', view.result.summary.slice(0, 400));
  console.log('findings:', view.result.findings.length, '| alternatives:', view.result.alternatives.length,
    '| decision_changers:', view.result.decision_changers.length, '| next_checks:', view.result.next_checks.length,
    '| remaining_disagreements:', view.result.remaining_disagreements.length);
  console.log('usage:', JSON.stringify(view.usage));
  console.log('quality:', JSON.stringify(view.quality));
} else {
  console.log('failure:', JSON.stringify(view.failure));
}

console.log('\n--- 2. follow-up round on the same chain ---');
const fu = P(await client.callTool({ name: 'consult_start', arguments: { request: { ...request, mode: 'debate',
  question: 'Given your answer, does anything change if ids are only ever copied by the model, never typed by a human?',
  context: { ...request.context, facts: [...request.context.facts, 'The lead pastes the id back verbatim from the tool result.'] },
  followup_to: started.job_id } } }));
console.log('followup job:', fu.job_id, '| round:', fu.round, '| chain matches:', fu.chain_id === started.chain_id);

console.log('\n--- 3. cancel it mid-flight; confirm the child CLI dies ---');
await new Promise((r) => setTimeout(r, 4000));
const before = countClaudeChildren();
const cancelled = P(await client.callTool({ name: 'consult_cancel', arguments: { job_id: fu.job_id } }));
console.log('cancel ->', cancelled.status, '|', cancelled.cancel_effect);
let after = before;
for (let i = 0; i < 40 && after >= before && before > 0; i++) {
  await new Promise((r) => setTimeout(r, 250));
  after = countClaudeChildren();
}
const final = P(await client.callTool({ name: 'consult_get', arguments: { job_id: fu.job_id, wait_ms: 30000 } }));
console.log(`consultant CLI processes: ${before} before cancel -> ${countClaudeChildren()} after`);
console.log('final status:', final.status, '| failure:', JSON.stringify(final.failure));

console.log('\n--- 4. history ---');
console.log(JSON.stringify(P(await client.callTool({ name: 'consult_list', arguments: { limit: 5 } })).jobs, null, 1));
await client.close();

function countClaudeChildren() {
  try {
    const out = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.includes('--no-session-persistence') && l.includes('--restricted')).length;
  } catch { return 0; }
}
