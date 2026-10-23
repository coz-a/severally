import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv, reviewRequest, exploreRequest } from './helpers.mjs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

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

test("exposes the three protocol tools, the lead's record, and a history listing", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['consult_cancel', 'consult_export', 'consult_get', 'consult_list', 'consult_record', 'consult_start']);
  const record = tools.find((t) => t.name === 'consult_record');
  assert.deepEqual(record.inputSchema.properties.entries.items.properties.verdict.enum, [
    'unverified',
    'confirmed',
    'not_applicable',
    'unverifiable',
  ]);
  const start = tools.find((t) => t.name === 'consult_start');
  const req = start.inputSchema.properties.request;
  // Which names reach a consultant depends on the operator's config, so
  // target is a plain string and the description lists who can be asked.
  assert.equal(req.properties.target.type, 'string');
  assert.match(start.description, /^ {10}opencode: opencode, zai-coding-plan\/glm-5\.3$/m);
  assert.match(start.description, /targets: \["all"\]/);
  assert.doesNotMatch(start.description, /claude:claude-opus|allowed_models|suffix/);
  assert.deepEqual(req.properties.mode.enum, ['explore', 'review', 'debate']);
  assert.equal(req.required.includes('mode'), false, 'a mode left out is read from the context');
  assert.equal(req.additionalProperties, false, 'requests must not accept extra fields');
  await close();
});

test('only the tools that change nothing are annotated read-only', async () => {
  // Codex's auto mode reads readOnlyHint to decide whether a call needs approval.
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const readOnly = tools
    .filter((t) => t.annotations?.readOnlyHint === true)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(readOnly, ['consult_export', 'consult_get', 'consult_list']);
  for (const t of tools) assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} declares readOnlyHint`);
  await close();
});

test('consult_record says where job_id comes from, so it is passed instead of dropped', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const record = tools.find((t) => t.name === 'consult_record');
  assert.match(
    record.inputSchema.properties.job_id.description ?? '',
    /consult_get/,
    'job_id is the field most often dropped when recording; its description must name where the id comes from',
  );
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
  assert.match(
    view.next_step,
    /one check that would change the decision/,
    'a completed answer must send the lead to run the decisive check, not only to read',
  );

  const listed = payload(await client.callTool({ name: 'consult_list', arguments: {} }));
  assert.equal(listed.jobs[0].job_id, started.job_id);
  await close();
});

// A self-contained question needs no separate context to start a consultation.
const questionOnlyRequest =
  'Review this design in at most 200 words. A worker charges a credit card then ACKs a queue message. On a timeout the queue retries the message. Is retrying safe? Give one concrete failure sequence, a minimal mitigation, and a test. Do not edit files, consult agents, or use the network.';

test('a question-only request launches, replies and accepts a follow-up', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  try {
    const started = payload(
      await client.callTool({
        name: 'consult_start',
        arguments: { request: { target: 'codex', question: questionOnlyRequest, network: 'off', caller: 'codex' } },
      }),
    );
    assert.ok(started.job_id, JSON.stringify(started));
    const view = payload(
      await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000, detail: 'full' } }),
    );
    assert.equal(view.status, 'completed');
    assert.ok(view.result.summary);
    assert.equal(view.question, questionOnlyRequest);
    assert.deepEqual(view.brief.facts, []);
    const next = payload(
      await client.callTool({
        name: 'consult_start',
        arguments: { request: { followup_to: started.job_id, question: 'Which test would reveal duplicate charges?' } },
      }),
    );
    assert.ok(next.job_id, JSON.stringify(next));
    const reply = payload(
      await client.callTool({ name: 'consult_get', arguments: { job_id: next.job_id, wait_ms: 20000, detail: 'full' } }),
    );
    assert.equal(reply.status, 'completed');
    assert.ok(reply.result.summary);
    assert.deepEqual(reply.brief.facts, []);
  } finally {
    await close();
  }
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

test('a waiting consult_get sends progress, and a request the client cancels stops the wait', async (t) => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
  const { client, manager, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));

  // The interval is 15 s; mocked, so the test does not sit through it.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const progress = [];
  const pending = client.callTool(
    { name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 1500 } },
    { onprogress: (p) => progress.push(p) },
  );
  await new Promise((r) => setTimeout(r, 100));
  t.mock.timers.tick(15_000);
  assert.equal(payload(await pending).status, 'running');
  assert.equal(progress.length, 1);
  assert.match(progress[0].message, /still running/);
  t.mock.timers.reset();

  // The wait itself ends with the signal, not when its budget runs out.
  const ac = new AbortController();
  const t0 = Date.now();
  const waiting = manager.wait(started.job_id, 10_000, {}, ac.signal);
  setTimeout(() => ac.abort(), 50);
  assert.equal((await waiting).status, 'running');
  assert.ok(Date.now() - t0 < 2_000, `waited ${Date.now() - t0} ms after the abort`);

  manager.cancel(started.job_id);
  await manager.jobs.get(started.job_id).promise;
  process.env.STUB_BEHAVIOR = 'ok';
  await close();
});

test('cancel over MCP reports the effect; unknown ids are handled', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  process.env.SEVERALLY_TIMEOUT_MS = '2000';
  const { client, manager, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  const cancelled = payload(await client.callTool({ name: 'consult_cancel', arguments: { job_id: started.job_id } }));
  assert.equal(cancelled.status, 'cancelling');
  await manager.jobs.get(started.job_id).promise;
  const view = payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id } }));
  assert.equal(view.status, 'cancelled');

  const unknown = await client.callTool({ name: 'consult_get', arguments: { job_id: 'job_missing' } });
  assert.equal(unknown.isError, true);
  process.env.SEVERALLY_TIMEOUT_MS = '20000';
  process.env.STUB_BEHAVIOR = 'ok';
  await close();
});

test('a fan-out is started, fetched and compared through group_id over MCP', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(
    await client.callTool({
      name: 'consult_start',
      arguments: { request: reviewRequest({ target: undefined, targets: ['codex', 'gemini'] }) },
    }),
  );
  assert.ok(started.group_id);
  assert.equal(started.job_id, undefined, 'a fan-out has no single job_id to poll');
  assert.deepEqual(
    started.jobs.map((j) => j.target),
    ['codex', 'antigravity'],
  );
  assert.match(started.poll_with, /group_id/);

  // Poll exactly as the server told us to: no wait_ms, so consult_get's default wait does the waiting.
  assert.equal(started.poll_with, `consult_get({ group_id: "${started.group_id}" })`);
  const polled = await client.callTool({ name: 'consult_get', arguments: { group_id: started.group_id } });
  assert.notEqual(polled.isError, true, 'the poll_with advice must be a valid call');
  const view = payload(polled);
  assert.equal(view.status, 'done');
  assert.equal(view.members_available, 2);
  assert.deepEqual(
    view.comparison.by_target.map((t) => t.target),
    ['codex', 'antigravity'],
  );
  assert.match(view.comparison.note, /does not judge/);
  assert.equal(view.members[0].result, undefined, "a member's full answer is one consult_get({ job_id }) away");
  const full = payload(await client.callTool({ name: 'consult_get', arguments: { group_id: started.group_id, detail: 'full' } }));
  assert.equal(full.members[0].result, undefined, 'detail: "full" adds the brief, not every answer again');
  assert.ok(full.comparison.by_target[0].summary);
  assert.ok(full.brief.objective);
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

test('consult_get waits by default, and wait_ms: 0 answers at once', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  assert.equal(started.poll_with, `consult_get({ job_id: "${started.job_id}" })`);
  assert.equal(
    payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 0 } })).status,
    'running',
  );
  assert.equal(
    payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id } })).status,
    'completed',
  );
  await close();
});

test('a verdict written over MCP lands on the consultation and comes back in the listing', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } });

  const recorded = payload(
    await client.callTool({
      name: 'consult_record',
      arguments: { job_id: started.job_id, entries: [{ id: 'f1', verdict: 'confirmed', effect: 'Capped the retries.' }] },
    }),
  );
  assert.deepEqual(recorded.record.verdicts, { confirmed: 1 });
  assert.deepEqual(recorded.record.coverage, { recordable: 3, recorded: 1 });

  const listed = payload(await client.callTool({ name: 'consult_list', arguments: {} })).jobs.find(
    (j) => j.job_id === started.job_id,
  );
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
    arguments: {
      job_id: started.job_id,
      entries: [{ id: 'f1', verdict: 'not_applicable', effect: 'That path is already capped upstream.' }],
    },
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
  const started = payload(
    await client.callTool({
      name: 'consult_start',
      arguments: { request: reviewRequest({ prediction: { expected: 'proceed', worry: 'The cap is the only real risk.' } }) },
    }),
  );
  await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } });

  const out = payload(
    await client.callTool({
      name: 'consult_record',
      arguments: {
        job_id: started.job_id,
        reflection: { delta: 'Expected the cap; the vacuum cost was new.', related_item_ids: ['f1'] },
      },
    }),
  );
  assert.equal(out.reflection_saved, true);
  const view = payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 0 } }));
  assert.equal(view.prediction.expected, 'proceed');
  assert.equal(view.reflection.delta, 'Expected the cap; the vacuum cost was new.');
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

test('an installed copy on another version is named, with how to bring it level', async () => {
  const { staleInstall } = await import('../src/server.mjs');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const osMod = await import('node:os');
  const home = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'sev-stale-'));
  const sevHome = pathMod.join(home, '.severally');
  assert.equal(staleInstall(home, sevHome), null, 'no other copy: nothing to report');
  fsMod.mkdirSync(pathMod.join(sevHome, 'runtime'), { recursive: true });
  // A 1.8.1 bundle, as the runtime install leaves it, beside a package.json a later --manual install never rewrote.
  fsMod.writeFileSync(
    pathMod.join(sevHome, 'runtime', 'severally-mcp.mjs'),
    "new McpServer({ name: 'severally', version: '1.8.1' })",
  );
  fsMod.writeFileSync(pathMod.join(sevHome, 'runtime', 'package.json'), JSON.stringify({ version: '0.0.1' }));
  const stale = staleInstall(home, sevHome);
  assert.deepEqual(stale.behind, ['runtime']);
  assert.equal(stale.copies.runtime, '1.8.1');
  assert.match(stale.fix, /install\.mjs/);
});

test('the server reports the version package.json releases', async () => {
  const { SEVERALLY_VERSION: VERSION } = await import('../src/server.mjs');
  const fsMod = await import('node:fs');
  const pkg = JSON.parse(fsMod.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version, 'bump src/server.mjs with package.json, or every install reads as stale');
});

test('consult_get with ids returns just those points, whole, with their verdicts', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, manager, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  const full = payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } }));
  const ids = [full.result.findings[0].id, full.result.unknowns[0].id];
  manager.record({ job_id: started.job_id, entries: [{ id: ids[0], verdict: 'confirmed', effect: 'checked' }] });
  const got = payload(await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, ids } }));
  assert.deepEqual(
    got.points.map((p) => [p.id, p.kind]),
    [
      [ids[0], 'finding'],
      [ids[1], 'unknown'],
    ],
  );
  const { kind, recorded, ...finding } = got.points[0];
  assert.deepEqual(finding, full.result.findings[0], 'the point comes back whole, grounds included');
  assert.equal(recorded.verdict, 'confirmed');
  assert.equal(got.points[1].recorded, null);
  assert.match(got.next_step, /still carry no verdict/);
  assert.equal(got.not_shown.findings, full.result.findings.length - 1);
  assert.match(got.full_with, /consult_get/);
  assert.equal(got.result, undefined, 'the rest of the answer is not repeated');

  const bad = await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, ids: ['f99'] } });
  assert.equal(bad.isError, true);
  assert.equal(payload(bad).error, 'unknown_entry_id');
  assert.match(payload(bad).message, new RegExp(ids[0]));
  const group = await client.callTool({ name: 'consult_get', arguments: { group_id: started.group_id, ids } });
  assert.equal(group.isError, true);
  await close();
});

test('consult_get with ids on a consultation that produced no answer is refused', async () => {
  process.env.STUB_BEHAVIOR = 'usage_limit';
  const { client, close } = await connect();
  const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
  const res = await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000, ids: ['f1'] } });
  process.env.STUB_BEHAVIOR = 'ok';
  assert.equal(res.isError, true);
  assert.equal(payload(res).error, 'no_result');
  await close();
});

test('consult_get with ids on a running consultation answers the poll as usual', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const { client, manager, close } = await connect();
  try {
    const started = payload(await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } }));
    const res = await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, ids: ['f1'], wait_ms: 0 } });
    assert.notEqual(res.isError, true);
    assert.equal(payload(res).status, 'running');
    manager.cancel(started.job_id);
    await manager.jobs.get(started.job_id).promise;
  } finally {
    process.env.STUB_BEHAVIOR = 'ok';
    await close();
  }
});

test('over MCP, a follow-up with only followup_to and the question is accepted, and an explicit empty list is kept', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { client, close } = await connect();
  const call = async (request) => client.callTool({ name: 'consult_start', arguments: { request } });
  const { debateRequest } = await import('./helpers.mjs');
  const first = payload(await call(debateRequest()));
  await client.callTool({ name: 'consult_get', arguments: { job_id: first.job_id, wait_ms: 20000 } });
  const empty = await call({ followup_to: first.job_id, question: 'q', context: { counterpoints: [] } });
  assert.equal(payload(empty).error, 'counterpoints_required');
  const next = await call({ followup_to: first.job_id, question: 'Which counterpoint is strongest?' });
  assert.equal(next.isError, undefined, next.content[0].text);
  assert.equal(payload(next).round, 2);
  await close();
});
