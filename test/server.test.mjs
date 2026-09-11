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

test('exposes the three protocol tools, the lead\'s record, and a history listing', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['consult_cancel', 'consult_export', 'consult_get', 'consult_list', 'consult_record', 'consult_start']);
  const record = tools.find((t) => t.name === 'consult_record');
  assert.deepEqual(
    record.inputSchema.properties.entries.items.properties.verdict.enum,
    ['unverified', 'confirmed', 'not_applicable', 'unverifiable'],
  );
  const start = tools.find((t) => t.name === 'consult_start');
  const req = start.inputSchema.properties.request;
  // target is now "a name" or "a name with a model suffix", so the accepted
  // names live in the first branch of the union rather than at the top level.
  assert.deepEqual(req.properties.target.anyOf[0].enum, [
    'codex', 'gpt', 'chatgpt', 'openai',
    'claude-code', 'claude', 'anthropic',
    'antigravity', 'agy', 'gemini', 'google',
  ]);
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
  assert.match(view.next_step, /one check that would change the decision/,
    'a completed answer must send the lead to run the decisive check, not only to read');

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

test('a fan-out is started, fetched and compared through group_id over MCP', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({
    name: 'consult_start',
    arguments: { request: reviewRequest({ target: undefined, targets: ['codex', 'gemini'] }) },
  }));
  assert.ok(started.group_id);
  assert.equal(started.job_id, undefined, 'a fan-out has no single job_id to poll');
  assert.deepEqual(started.jobs.map((j) => j.target), ['codex', 'antigravity']);
  assert.match(started.poll_with, /group_id/);

  const view = payload(await client.callTool({
    name: 'consult_get',
    arguments: { group_id: started.group_id, wait_ms: 20000 },
  }));
  assert.equal(view.status, 'done');
  assert.equal(view.members_available, 2);
  assert.deepEqual(view.comparison.by_target.map((t) => t.target), ['codex', 'antigravity']);
  assert.match(view.comparison.note, /does not judge/);
  await close();
});

test('consult_get and consult_cancel take exactly one of job_id or group_id', async () => {
  const { client, close } = await connect();
  for (const name of ['consult_get', 'consult_cancel']) {
    const both = await client.callTool({ name, arguments: { job_id: 'job_x', group_id: 'group_x' } });
    assert.equal(both.isError, true, `${name} must refuse both ids`);
    assert.equal(payload(both).error, 'invalid_request');

    const neither = await client.callTool({ name, arguments: {} });
    assert.equal(neither.isError, true, `${name} must refuse neither id`);
    assert.equal(payload(neither).error, 'invalid_request');

    const unknown = await client.callTool({ name, arguments: { group_id: 'group_missing' } });
    assert.equal(unknown.isError, true);
    assert.equal(payload(unknown).error, 'unknown_job');
    assert.match(payload(unknown).message, /group_id "group_missing"/);
  }
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

test('a verdict written over MCP lands on the consultation and comes back in the listing', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } });

  const recorded = payload(await client.callTool({
    name: 'consult_record',
    arguments: { job_id: started.job_id, entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Capped the retries.' }] },
  }));
  assert.deepEqual(recorded.record.verdicts, { confirmed: 1 });
  assert.deepEqual(recorded.record.unrecorded, ['u1', 'c1']);

  const listed = payload(await client.callTool({ name: 'consult_list', arguments: {} })).jobs
    .find((j) => j.job_id === started.job_id);
  assert.equal(listed.recorded, true);
  await close();
});

test('an id the consultant never produced is refused, with the ids that exist', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } });

  const res = await client.callTool({
    name: 'consult_record',
    arguments: { job_id: started.job_id, entries: [{ id: 'f9', verdict: 'confirmed' }] },
  });
  assert.equal(res.isError, true);
  const err = payload(res);
  assert.equal(err.error, 'unknown_entry_id');
  assert.match(err.message, /f1, u1, c1/);
  await close();
});

test('a finished consultation can be exported as a record to commit', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  const view = payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } }));
  await client.callTool({
    name: 'consult_record',
    arguments: { job_id: started.job_id, entries: [{ id: 'f1', verdict: 'not_applicable', effect: 'That path is already capped upstream.' }] },
  });

  const exported = payload(await client.callTool({ name: 'consult_export', arguments: { chain_id: view.chain_id } }));
  assert.equal(exported.rounds, 1);
  assert.match(exported.markdown, /# Consultation record/);
  assert.match(exported.markdown, /not_applicable/);
  assert.match(exported.markdown, /That path is already capped upstream\./);
  await close();
});

test('exporting a consultation that is not in the history is refused', async () => {
  const { client, close } = await connect();
  const res = await client.callTool({ name: 'consult_export', arguments: { chain_id: 'chain_missing' } });
  assert.equal(res.isError, true);
  assert.equal(payload(res).error, 'unknown_chain');
  await close();
});

test('a prediction goes in with the request and a reflection comes back with the record', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({
    name: 'consult_start',
    arguments: { request: reviewRequest({ prediction: { expected: 'proceed', worry: 'The cap is the only real risk.' } }) },
  }));
  await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } });

  const out = payload(await client.callTool({
    name: 'consult_record',
    arguments: { job_id: started.job_id, reflection: { delta: 'Expected the cap; the vacuum cost was new.', related_item_ids: ['f1'] } },
  }));
  assert.equal(out.prediction.expected, 'proceed');
  assert.equal(out.reflection.delta, 'Expected the cap; the vacuum cost was new.');
  await close();
});

test('the record tool offers no way to write a prediction after the fact', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const record = tools.find((t) => t.name === 'consult_record');
  assert.equal(record.inputSchema.properties.prediction, undefined);
  assert.ok(record.inputSchema.properties.reflection, 'but a reflection can be written afterwards');
  await close();
});
