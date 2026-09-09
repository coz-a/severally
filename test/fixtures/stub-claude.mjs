#!/usr/bin/env node
// Stand-in for `claude -p` used by the test suite.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.STUB_ARGV_OUT) fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(args));
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify(process.env));

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => run());

const structured = {
  summary: 'Stub Claude Code consultant view.',
  confidence: 'high',
  evidence_basis: 'thin',
  findings: [{ point: 'Unbounded queue', grounds: '', impact: 'OOM under load', severity: 'high', confidence: 'high' }],
  alternatives: [],
  unknowns: [],
  decision_changers: [],
  next_checks: [],
  remaining_disagreements: [{ topic: 'Whether to shard', your_position: 'Not yet', why_unresolved: 'No traffic data' }],
  references: [],
};

function run() {
  if (process.env.STUB_BRIEF_OUT) fs.writeFileSync(process.env.STUB_BRIEF_OUT, stdin);
  const behavior = process.env.STUB_BEHAVIOR ?? 'ok';
  if (behavior === 'usage_limit') {
    process.stdout.write(`${JSON.stringify({
      type: 'result', subtype: 'success', is_error: true,
      result: "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai to continue.",
      total_cost_usd: 0, duration_ms: 700, modelUsage: {},
    })}\n`);
    process.exit(0);
  }
  if (behavior === 'model_unavailable') {
    process.stdout.write('[claude-code:unrecognized_model] {"model":"bogus"}\n');
    process.stdout.write(`${JSON.stringify({
      type: 'result', is_error: true, api_error_status: 404,
      result: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it.",
    })}\n`);
    process.exit(0);
  }
  if (behavior === 'invalid') {
    process.stdout.write(`${JSON.stringify({
      type: 'result', is_error: false, result: 'Sure! Here are my thoughts in prose form.', total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 20 }, num_turns: 1,
    })}\n`);
    process.exit(0);
  }
  if (behavior === 'crash') {
    process.stderr.write('claude: unexpected error\n');
    process.exit(3);
  }
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify(structured), structured_output: structured,
    total_cost_usd: 0.0421, duration_ms: 12345, num_turns: 2,
    usage: { input_tokens: 5000, output_tokens: 900, cache_read_input_tokens: 1200, server_tool_use: { web_search_requests: 3 } },
    permission_denials: [],
  })}\n`);
  process.exit(0);
}
