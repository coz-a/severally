import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolInputs, MAX_ENTRIES, MAX_CHARS } from '../src/tool-inputs.mjs';
import * as codex from '../src/adapters/codex.mjs';
import * as agy from '../src/adapters/antigravity.mjs';
import * as opencode from '../src/adapters/opencode.mjs';

const lines = (...o) => o.map((x) => JSON.stringify(x)).join('\n');

test('Codex commands: one per item id, shell wrapper removed, output never read', () => {
  const stdout = lines(
    {
      type: 'item.started',
      item: { id: 'a', type: 'command_execution', command: "/bin/bash -lc 'rg -n retry src'", aggregated_output: '' },
    },
    {
      type: 'item.completed',
      item: { id: 'a', type: 'command_execution', command: "/bin/bash -lc 'rg -n retry src'", aggregated_output: 'TOP SECRET' },
    },
    { type: 'item.completed', item: { id: 'b', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'c', type: 'agent_message', text: 'done' } },
    { type: 'item.completed', item: { id: 'd', type: 'command_execution' } },
  );
  assert.deepEqual(codex.toolInputs({ stdout }), ['rg -n retry src', 'ls']);
});

test('Antigravity: the path parameters of its tool calls, once per step', () => {
  const step = (state) => ({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state,
      tool_name: 'read_file',
      tool_info: { name: 'read_file', parameters: { Path: '/w/workspace/0-a.mjs', Other: 'x' } },
    },
  });
  const stdout = lines(step('ACTIVE'), step('DONE'), {
    event: 'step_update',
    step_update: { step_index: 3, step_type: 'agent_response' },
  });
  assert.deepEqual(agy.toolInputs({ stdout }), ['/w/workspace/0-a.mjs']);
});

// The event as opencode 2.0.24 wrote it for a read (checked 2026-10-24): one
// completed event per call, the call id in part.id, the path in state.input.
test('OpenCode: the path fields of a call survive compactLine, which still drops the result', () => {
  const call = (id, input, extra = {}) =>
    JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', id, tool: 'read', state: { status: 'completed', input, output: 'FILE BODY '.repeat(500), ...extra } },
    });
  const raw = [
    call('call_a', { path: 'workspace/0-a.mjs' }),
    call('call_a', { path: 'workspace/0-a.mjs' }),
    call('call_b', { filePath: 'workspace/0-b.mjs', content: 'x' }),
  ];
  const stdout = raw.map((l) => opencode.compactLine(l)).join('\n');
  assert.ok(!stdout.includes('FILE BODY') && !stdout.includes('"content"'), 'only path-like fields are kept');
  assert.deepEqual(opencode.toolInputs({ stdout }), ['workspace/0-a.mjs', 'workspace/0-b.mjs'], 'one per call id');
  assert.deepEqual(opencode.toolCalls({ stdout }), { read: 2 });
});

test('a summary masks a secret before it cuts, caps the list, and counts the handed-over files a call names', () => {
  const key = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const near = `${'x'.repeat(MAX_CHARS - 12)} curl -H "Authorization: Bearer ${key}"`;
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `cat 0-lib/f${i}.mjs`);
  const s = summarizeToolInputs([near, ...many, many[0]], ['0-lib/f0.mjs', '0-lib/f34.mjs', '0-lib/never.mjs']);
  assert.equal(s.entries.length, MAX_ENTRIES);
  assert.equal(s.omitted, MAX_ENTRIES + 5 + 1 - MAX_ENTRIES, 'distinct inputs only; the repeat is not counted');
  assert.ok(!s.entries.join('\n').includes(key.slice(3, 20)), 'the key is masked, not half-shown');
  assert.ok(s.entries.every((e) => e.length <= MAX_CHARS + 1));
  assert.equal(s.exposed_files, 3);
  assert.equal(s.exposed_mentioned, 2, 'a name in the inputs beyond the shown entries still counts');
});
