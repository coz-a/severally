#!/usr/bin/env node
// Stand-in for `claude -p` used by the test suite.
import fs from 'node:fs';
import path from 'node:path';

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
  stance: 'do_not_proceed',
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
  // STUB_BRIEF_OUT is a single shared path: in a fan-out several children would
  // overwrite each other's brief, so also drop one file per target.
  if (process.env.STUB_BRIEF_DIR) {
    fs.writeFileSync(path.join(process.env.STUB_BRIEF_DIR, `${process.env.SEVERALLY_TARGET ?? 'unknown'}.txt`), stdin);
  }
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
  // Counts its own runs in STUB_COUNT_FILE: rate limited on the first,
  // a normal answer afterwards.
  if (behavior === 'rate_limited_once' || behavior === 'rate_limited') {
    const n = Number(fs.existsSync(process.env.STUB_COUNT_FILE) ? fs.readFileSync(process.env.STUB_COUNT_FILE, 'utf8') : 0) + 1;
    fs.writeFileSync(process.env.STUB_COUNT_FILE, String(n));
    if (behavior === 'rate_limited' || n === 1) {
      process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 429 Too Many Requests', total_cost_usd: 0.002, usage: { input_tokens: 40, output_tokens: 0 } })}\n`);
      process.exit(0);
    }
  }
  if (behavior === 'sleep') {
    process.stdout.write('{"type":"system","subtype":"init","note":"partial line one"}\n');
    setTimeout(() => process.exit(0), 60_000);
    return;
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
