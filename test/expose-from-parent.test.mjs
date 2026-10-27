import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandboxEnv, reviewRequest } from './helpers.mjs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const home = sandboxEnv();
const { createServer } = await import('../src/server.mjs');

async function connect() {
  const { server } = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

const payload = (res) => JSON.parse(res.content[0].text);

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-inherit-'));
  fs.writeFileSync(path.join(dir, 'one.mjs'), 'export const one = 1;\n');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'two.mjs'), 'export const two = 2;\n');
  return dir;
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-inherit-git-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 2;\n');
  return { dir, g };
}

// One round over MCP, answered by the stub; returns the start payload, the
// finished view (in full) and what the consultant's working directory held.
async function round(client, request) {
  const cwdOut = path.join(home, `cwd-${Date.now()}-${Math.random()}.json`);
  process.env.STUB_BEHAVIOR = 'ok';
  process.env.STUB_CWD_OUT = cwdOut;
  const res = await client.callTool({ name: 'consult_start', arguments: { request } });
  const started = payload(res);
  if (res.isError) {
    delete process.env.STUB_CWD_OUT;
    return { started, error: true };
  }
  const view = payload(
    await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000, detail: 'full' } }),
  );
  delete process.env.STUB_CWD_OUT;
  return { started, view, cwd: JSON.parse(fs.readFileSync(cwdOut, 'utf8')) };
}

const followup = (parent, context) =>
  reviewRequest({ followup_to: parent.job_id, context: { proposal: 'p', facts: ['f'], ...context } });

test('a follow-up to a round that exposed no files is not offered expose_from_parent: true', async () => {
  const client = await connect();
  const none = await round(client, reviewRequest({ context: { proposal: 'p' } }));
  const next = await round(client, followup(none.view, {}));
  assert.match(next.started.files_note, /context\.expose_paths/);
  assert.doesNotMatch(next.started.files_note, /expose_from_parent/);
  await client.close();
});

test("a follow-up copies the parent round's paths again; expose_from_parent: false keeps them back", async () => {
  const client = await connect();
  const dir = tree();
  const first = await round(
    client,
    reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs'), path.join(dir, 'lib')] } }),
  );
  assert.ok(first.cwd.includes('workspace/0-one.mjs'));

  const other = await round(client, reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs')] } }));
  const bare = await round(client, followup(other.view, { expose_from_parent: false }));
  assert.equal(
    bare.cwd.some((p) => p.startsWith('workspace/')),
    false,
    'expose_from_parent: false sends no files',
  );
  assert.equal(bare.started.files_note, undefined, 'a text-only follow-up asked for no files and is not told to resend them');

  fs.writeFileSync(path.join(dir, 'lib', 'three.mjs'), 'export const three = 3;\n');
  const second = await round(client, followup(first.view));
  assert.deepEqual(second.cwd.filter((p) => p.startsWith('workspace/')).sort(), [
    'workspace/0-one.mjs',
    'workspace/1-lib/three.mjs',
    'workspace/1-lib/two.mjs',
  ]);
  assert.deepEqual(
    second.started.exposed_from_parent.entries.map((e) => [e.exposed_as, e.changed]),
    [
      ['workspace/0-one.mjs', false],
      ['workspace/1-lib', true],
    ],
  );
  assert.equal(second.started.exposed_from_parent.files, 3);
  assert.equal(second.started.files_note, undefined);
  await client.close();
});

test("a follow-up that adds expose_paths keeps the parent round's paths too", async () => {
  const client = await connect();
  const dir = tree();
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs')] } }));
  const next = await round(client, followup(first.view, { expose_paths: [path.join(dir, 'lib')] }));
  assert.deepEqual(next.cwd.filter((p) => p.startsWith('workspace/')).sort(), ['workspace/0-one.mjs', 'workspace/1-lib/two.mjs']);
  await client.close();
});

test('a follow-up whose parent exposed nothing goes ahead without files unless the flag asks for them', async () => {
  const client = await connect();
  const first = await round(client, reviewRequest());
  const next = await round(client, followup(first.view));
  assert.equal(next.error, undefined);
  assert.equal(next.started.files_exposed, 0);
  await client.close();
});

test('a parent round that ran on another model than the consultant now has is not copied again by default', async () => {
  const dir = tree();
  let client = await connect();
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs')] } }));
  await client.close();
  // The operator has since pointed the name at another model: the history
  // says the parent ran on one this consultant no longer is.
  const file = path.join(home, 'history', first.view.chain_id, 'round-01.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...stored, model: 'an-earlier-model' }));
  client = await connect();
  const next = await round(client, followup(first.view));
  assert.equal(next.started.files_exposed, 0);
  await client.close();
});

test('a follow-up whose parent exposed nothing is refused rather than sent without files', async () => {
  const client = await connect();
  const first = await round(client, reviewRequest());
  const res = await round(client, followup(first.view, { expose_from_parent: true }));
  assert.equal(res.error, true);
  assert.equal(res.started.error, 'nothing_to_inherit');
  await client.close();
});

test('expose_paths and expose_from_parent together copy both, once each', async () => {
  const client = await connect();
  const dir = tree();
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs')] } }));
  const next = await round(
    client,
    followup(first.view, {
      expose_from_parent: true,
      expose_paths: [path.join(dir, 'one.mjs'), path.join(dir, 'lib')],
    }),
  );
  assert.deepEqual(next.cwd.filter((p) => p.startsWith('workspace/')).sort(), ['workspace/0-one.mjs', 'workspace/1-lib/two.mjs']);
  await client.close();
});

test('an expose_diff round is followed up with the files it touched, as they are now, and no new diff', async () => {
  const client = await connect();
  const { dir, g } = repo();
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  assert.ok(first.cwd.includes('workspace/repo/a.mjs'));
  // Committed since: a fresh diff against HEAD would now be empty and refused.
  g('commit', '-qam', 'land it');
  const next = await round(client, followup(first.view, { expose_from_parent: true }));
  assert.ok(next.cwd.includes('workspace/repo/a.mjs'));
  const entry = next.view.brief.expose_paths.entries[0];
  assert.equal(entry.kind, 'change_files');
  assert.equal(entry.changed_since_parent, false);
  assert.equal(
    next.view.brief.artifacts.some((a) => a.kind === 'diff'),
    false,
    'the diff is not taken again',
  );
  await client.close();
});

test('expose_paths and expose_diff in the parent both come back', async () => {
  const client = await connect();
  const dir = tree();
  const { dir: r } = repo();
  const first = await round(
    client,
    reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs')], expose_diff: { repo: r } } }),
  );
  const next = await round(client, followup(first.view, { expose_from_parent: true }));
  assert.deepEqual(next.cwd.filter((p) => p.startsWith('workspace/')).sort(), ['workspace/0-one.mjs', 'workspace/repo/a.mjs']);
  await client.close();
});

test('a changed entry is marked, and a vanished one is left out without refusing the follow-up', async () => {
  const client = await connect();
  const dir = tree();
  const first = await round(
    client,
    reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs'), path.join(dir, 'lib')] } }),
  );
  fs.writeFileSync(path.join(dir, 'one.mjs'), 'export const one = 11;\n');
  fs.rmSync(path.join(dir, 'lib'), { recursive: true });
  const next = await round(client, followup(first.view, { expose_from_parent: true }));
  assert.equal(next.error, undefined);
  assert.deepEqual(
    next.started.exposed_from_parent.entries.map((e) => [e.exposed_as, e.changed]),
    [['workspace/0-one.mjs', true]],
  );
  assert.deepEqual(next.started.exposed_from_parent.left_out, [{ exposed_as: 'workspace/1-lib', reason: 'gone' }]);
  assert.deepEqual(
    next.cwd.filter((p) => p.startsWith('workspace/')),
    ['workspace/0-one.mjs'],
  );
  await client.close();
});

test('expose_from_parent on a first round is refused', async () => {
  const client = await connect();
  const res = await round(client, reviewRequest({ context: { proposal: 'p', facts: ['f'], expose_from_parent: true } }));
  assert.equal(res.started.error, 'expose_from_parent_needs_followup');
  await client.close();
});

test('an entry keeps its name when an earlier one is gone', async () => {
  const client = await connect();
  const dir = tree();
  const first = await round(
    client,
    reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs'), path.join(dir, 'lib')] } }),
  );
  fs.rmSync(path.join(dir, 'one.mjs'));
  const extra = path.join(dir, 'three.mjs');
  fs.writeFileSync(extra, 'export const three = 3;\n');
  const next = await round(client, followup(first.view, { expose_from_parent: true, expose_paths: [extra] }));
  assert.deepEqual(next.cwd.filter((p) => p.startsWith('workspace/')).sort(), [
    'workspace/1-lib/two.mjs',
    'workspace/2-three.mjs',
  ]);
  await client.close();
});

test('an inherited change path that now runs through a link out of the repository is not copied', async () => {
  const client = await connect();
  const { dir, g } = repo();
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'b.mjs'), 'export const b = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'lib');
  fs.writeFileSync(path.join(dir, 'lib', 'b.mjs'), 'export const b = 2;\n');
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  assert.ok(first.cwd.includes('workspace/repo/lib/b.mjs'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-outside-'));
  fs.writeFileSync(path.join(outside, 'b.mjs'), 'SECRET-ELSEWHERE\n');
  fs.rmSync(path.join(dir, 'lib'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  const next = await round(client, followup(first.view, { expose_from_parent: true }));
  assert.equal(next.cwd.includes('workspace/repo/lib/b.mjs'), false);
  assert.deepEqual(next.started.exposed_from_parent.left_out, [{ exposed_as: 'workspace/repo/lib/b.mjs', reason: 'symlink' }]);
  await client.close();
});

test('a file the earlier change deleted and that is back is copied as it is', async () => {
  const client = await connect();
  const { dir } = repo();
  fs.rmSync(path.join(dir, 'a.mjs'));
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 3;\n');
  const next = await round(client, followup(first.view, { expose_from_parent: true }));
  assert.ok(next.cwd.includes('workspace/repo/a.mjs'));
  assert.equal(next.view.brief.expose_paths.entries[0].changed_since_parent, true);
  await client.close();
});

test('a fresh expose_diff replaces the earlier change, named as such, and is marked against it', async () => {
  const client = await connect();
  const { dir } = repo();
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  const next = await round(client, followup(first.view, { expose_from_parent: true, expose_diff: { repo: dir } }));
  assert.deepEqual(next.started.exposed_from_parent.entries, []);
  assert.deepEqual(next.started.exposed_from_parent.left_out, [{ exposed_as: 'workspace/repo', reason: 'replaced' }]);
  assert.equal(next.view.brief.expose_paths.entries[0].kind, 'diff');
  assert.equal(next.view.brief.expose_paths.entries[0].changed_since_parent, false);
  await client.close();
});

test('a follow-up whose every earlier path is gone, with nothing else to go on, is refused', async () => {
  const client = await connect();
  const dir = tree();
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_paths: [path.join(dir, 'one.mjs')] } }));
  fs.rmSync(path.join(dir, 'one.mjs'));
  const res = await round(
    client,
    reviewRequest({ followup_to: first.view.job_id, context: { proposal: 'p', expose_from_parent: true } }),
  );
  assert.equal(res.started.error, 'nothing_to_inherit');
  await client.close();
});

test('an earlier change whose files are all gone leaves nothing, and with nothing else is refused', async () => {
  const client = await connect();
  const { dir } = repo();
  const first = await round(client, reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  fs.rmSync(path.join(dir, 'a.mjs'));
  const res = await round(
    client,
    reviewRequest({ followup_to: first.view.job_id, context: { proposal: 'p', expose_from_parent: true } }),
  );
  assert.equal(res.started.error, 'nothing_to_inherit');
  await client.close();
});

test('a group follow-up copies again what the fan-out exposed, not what one member was shown later', async () => {
  const client = await connect();
  const dir = tree();
  process.env.STUB_BEHAVIOR = 'ok';
  const start = async (request) => payload(await client.callTool({ name: 'consult_start', arguments: { request } }));
  const group = await start({
    targets: ['codex', 'claude-code'],
    question: 'q',
    context: { expose_paths: [path.join(dir, 'one.mjs')] },
  });
  await client.callTool({ name: 'consult_get', arguments: { group_id: group.group_id, wait_ms: 20000 } });
  const member = await start({
    followup_to: group.jobs[0].job_id,
    question: 'q2',
    context: { expose_paths: [path.join(dir, 'lib')] },
  });
  assert.equal(member.files_exposed, 2);
  await client.callTool({ name: 'consult_get', arguments: { job_id: member.job_id, wait_ms: 20000 } });
  const again = await start({ followup_to: group.group_id, question: 'q3' });
  assert.equal(again.files_exposed, 1);
  assert.deepEqual(
    again.exposed_from_parent.entries.map((e) => e.exposed_as),
    ['workspace/0-one.mjs'],
  );
  await client.callTool({ name: 'consult_get', arguments: { group_id: again.group_id, wait_ms: 20000 } });
  await client.close();
});
