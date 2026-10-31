import test from 'node:test';
import assert from 'node:assert/strict';
import { observeHostTrace } from '../scripts/host-observation.mjs';

test('host observations count executed tool calls once and keep Skill loading separate from direct MCP', () => {
  const call = { type: 'tool_use', id: 'a', name: 'mcp__severally__consult_start', input: { request: {} } };
  const assistant = (content) => ({ type: 'assistant', message: { content } });
  const trace = [
    assistant([{ type: 'text', text: 'Skill severally consult_start confirmed' }]),
    assistant([call]),
    assistant([call]),
    assistant([{ type: 'tool_use', id: 'b', name: 'mcp__severally__consult_get', input: {} }]),
    { type: 'result', usage: { input_tokens: 10, output_tokens: 20 }, total_cost_usd: 0.5, is_error: false },
  ];
  const result = observeHostTrace(trace.map((line) => JSON.stringify(line)).join('\n'));
  assert.deepEqual(result.consultation_calls, { consult_start: 1, consult_get: 1 });
  assert.equal(result.tool_calls, 2);
  assert.equal(result.skill_load_requested, false);
  assert.equal(result.skill_version_loaded, null, 'MCP activity does not attest the loaded Skill');
  assert.equal(result.cost_usd, 0.5);
  assert.equal(result.usage.input_tokens, 10);
});

test('a Skill request is observed without inventing its version or missing costs', () => {
  const trace = [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'severally:severally' } }] },
    },
    { type: 'result', is_error: true },
  ];
  const result = observeHostTrace(trace.map((line) => JSON.stringify(line)).join('\n') + '\nmalformed');
  assert.equal(result.skill_load_requested, true);
  assert.equal(result.skill_version_loaded, null);
  assert.equal(result.cost_usd, null);
  assert.equal(result.usage, null);
  assert.equal(result.host_succeeded, false);
  assert.equal(result.unparsed_lines, 1);
});
