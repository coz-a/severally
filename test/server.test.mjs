import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv, reviewRequest, exploreRequest } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

sandboxEnv();
const { createServer } = await import('../src/server.mjs');

async function connect() {
  const { server, manager } = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, manager, close: () => client.close() };
}

const payload = (res) => JSON.parse(res.content[0].text);

test('exposes the three protocol tools plus a history listing', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['consult_cancel', 'consult_get', 'consult_list', 'consult_start']);
  const start = tools.find((t) => t.name === 'consult_start');
  const req = start.inputSchema.properties.request;
  assert.deepEqual(req.properties.target.enum, ['codex', 'claude-code']);
  assert.deepEqual(req.properties.mode.enum, ['explore', 'review', 'debate']);
  assert.equal(req.additionalProperties, false, 'requests must not accept extra fields');
  await close();
});

test('start -> get -> structured result, over MCP', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  assert.ok(started.job_id);
  assert.equal(started.limits.models.codex, 'gpt-6-astra');

  const view = payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } }));
  assert.equal(view.status, 'completed');
  assert.equal(view.result.findings[0].point, 'Retry storm risk');
  assert.match(view.next_step, /remaining round/);

  const listed = payload(await client.callTool({ name: 'consult_list', arguments: {} }));
  assert.equal(listed.jobs[0].job_id, started.job_id);
  await close();
});

test('a request that tries to raise the model or permissions is rejected at the tool boundary', async () => {
  const { client, close } = await connect();
  const res = await client.callTool({
    name: 'consult_start',
    arguments: { request: { ...reviewRequest(), model: 'gpt-6-astra-max', sandbox: 'danger-full-access' } },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /request|unrecognized|additional/i);
  await close();
});

test('protocol violations come back as guidance, not as a crash', async () => {
  const { client, close } = await connect();
  const res = await client.callTool({
    name: 'consult_start',
    arguments: { request: exploreRequest({ context: { facts: ['f'], proposal: 'my plan' } }) },
  });
  assert.equal(res.isError, true);
  const body = payload(res);
  assert.equal(body.error, 'explore_proposal_not_allowed');
  assert.ok(body.limits.max_rounds_per_chain);
  await close();
});

test('cancel over MCP reports the effect; unknown ids are handled', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.PEER_CONSULT_TIMEOUT_MS = '2000';
  const { client, manager, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  const cancelled = payload(await client.callTool({ name: 'consult_cancel', arguments: { job_id: started.job_id } }));
  assert.equal(cancelled.status, 'cancelling');
  await manager.jobs.get(started.job_id).promise;
  const view = payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id } }));
  assert.equal(view.status, 'cancelled');

  const unknown = await client.callTool({ name: 'consult_get', arguments: { job_id: 'job_missing' } });
  assert.equal(unknown.isError, true);
  process.env.PEER_CONSULT_TIMEOUT_MS = '20000';
  process.env.STUB_BEHAVIOR = 'ok';
  await close();
});

test('wait_ms is capped below the request timeout MCP clients apply', async () => {
  const { POLICY } = await import('../src/policy.mjs');
  assert.ok(POLICY.maxWaitMs < 60_000, 'a wait longer than the client timeout would fail the whole tool call');
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const waitProp = tools.find((t) => t.name === 'consult_get').inputSchema.properties.wait_ms;
  assert.equal(waitProp.maximum, POLICY.maxWaitMs);
  const res = await client.callTool({ name: 'consult_get', arguments: { job_id: 'x', wait_ms: 600_000 } });
  assert.equal(res.isError, true, 'an over-cap wait must be rejected, not silently clamped');
  await close();
});
