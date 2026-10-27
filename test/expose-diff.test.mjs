import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandboxEnv, reviewRequest, waitFor, fileSymlinkUnavailable } from './helpers.mjs';

sandboxEnv();
const { JobManager } = await import('../src/jobs.mjs');
const store = await import('../src/store.mjs');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-diff-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  fs.writeFileSync(path.join(dir, 'a', 'util.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'b', 'util.mjs'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=old\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a', 'util.mjs'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(dir, 'b', 'util.mjs'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(dir, 'new.mjs'), 'export const n = 1;\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=sk-live-new-secret\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  return dir;
}

test('expose_diff copies the touched files at their repository paths and puts the diff in the brief', async () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const dir = repo();
  const mgr = new JobManager();
  const s = mgr.start(
    reviewRequest({
      target: undefined,
      targets: ['codex', 'claude-code'],
      context: { proposal: 'p', expose_diff: { repo: dir } },
    }),
  );
  const [j1, j2] = s.jobs.map((j) => mgr.jobs.get(j.job_id));
  assert.ok(!fs.existsSync(store.jobDir(s.group_id)), 'the shared snapshot is gone once start() returns');
  await waitFor(() => j1.status === 'running' && j2.status === 'running');
  const ws = path.join(store.jobDir(j1.job_id), 'work', 'workspace', 'repo');
  assert.equal(fs.readFileSync(path.join(ws, 'a', 'util.mjs'), 'utf8'), 'export const a = 2;\n');
  assert.equal(
    fs.readFileSync(path.join(ws, 'b', 'util.mjs'), 'utf8'),
    'export const b = 2;\n',
    'same names in two directories stay apart',
  );
  assert.ok(fs.existsSync(path.join(ws, 'new.mjs')), 'an untracked file is copied');
  assert.ok(!fs.existsSync(path.join(ws, '.env')), 'a protected file is not copied');
  assert.ok(!fs.existsSync(path.join(ws, 'gone.txt')));

  const brief = j1.brief;
  const entry = brief.expose_paths.entries[0];
  assert.equal(entry.kind, 'diff');
  assert.ok(entry.changes.includes('gone.txt (deleted)'));
  assert.ok(entry.changes.includes('new.mjs (untracked)'));
  assert.equal(entry.sha256, j2.brief.expose_paths.entries[0].sha256, 'both members were handed the same bytes');
  const diff = brief.artifacts.find((a) => a.kind === 'diff');
  assert.match(diff.excerpt, /\+export const a = 2;/);
  assert.doesNotMatch(diff.excerpt, /sk-live-new-secret|\.env/, 'a protected file is left out of the diff too');
  assert.doesNotMatch(
    JSON.stringify(brief.artifacts),
    new RegExp(dir.replaceAll('/', '\\/')),
    'the repository location is not sent',
  );

  mgr.cancelGroup(s.group_id);
  await Promise.all([j1.promise, j2.promise]);
});

test('a clean tree is refused before any job exists', () => {
  const { dir } = bare();
  const mgr = new JobManager();
  assert.throws(
    () => mgr.start(reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } })),
    (e) => e.code === 'expose_path_invalid' && /no change against HEAD/.test(e.message),
  );
});

test('a change of many files does not put them all on the command line', () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const { dir, g } = bare();
  fs.mkdirSync(path.join(dir, 'many'));
  for (let i = 0; i < 3000; i += 1) fs.writeFileSync(path.join(dir, 'many', `file-with-a-long-name-${i}.txt`), `${i}\n`);
  g('add', '-A');
  g('commit', '-qm', 'many');
  fs.rmSync(path.join(dir, 'many'), { recursive: true });
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  const entry = mgr.jobs.get(s.job_id).brief.expose_paths.entries[0];
  assert.equal(entry.changes.length, 3000);
  mgr.cancel(s.job_id);
});

test('expose_diff on a path that is not a repository is refused before any job exists', () => {
  const mgr = new JobManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-norepo-'));
  assert.throws(
    () => mgr.start(reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } })),
    (e) => e.code === 'expose_path_invalid',
  );
  assert.equal(mgr.jobs.size, 0);
});

test('expose_diff refuses a base that looks like an option', () => {
  const mgr = new JobManager();
  assert.throws(
    () => mgr.start(reviewRequest({ context: { proposal: 'p', expose_diff: { repo: '/tmp', base: '--output=/tmp/x' } } })),
    (e) => e.code === 'invalid_request',
  );
});

function bare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-diff-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, g };
}

test('a change that only deletes a file still starts, with the deletion in the brief', async () => {
  process.env.STUB_BEHAVIOR = 'ok';
  const { dir } = bare();
  fs.rmSync(path.join(dir, 'a.txt'));
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  await mgr.jobs.get(s.job_id).promise;
  const v = mgr.view(s.job_id, { detail: 'full' });
  assert.equal(v.status, 'completed');
  assert.deepEqual(v.brief.expose_paths.entries[0].changes, ['a.txt (deleted)']);
});

test('the diff keeps a/ and b/ prefixes whatever the repository config says', () => {
  process.env.STUB_BEHAVIOR = 'hang';
  const { dir, g } = bare();
  g('config', 'diff.dstPrefix', `${dir}/`);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'b\n');
  const mgr = new JobManager();
  const s = mgr.start(reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } }));
  const diff = mgr.jobs.get(s.job_id).brief.artifacts.find((a) => a.kind === 'diff').excerpt;
  assert.match(diff, /\+\+\+ b\/a\.txt/);
  assert.ok(!diff.includes(dir), 'the repository location is not in the diff');
  mgr.cancel(s.job_id);
});

test('a file over the size cap is refused before the request is accepted', () => {
  const { dir } = bare();
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(6 * 1024 * 1024));
  const mgr = new JobManager();
  assert.throws(
    () => mgr.start(reviewRequest({ context: { proposal: 'p', expose_diff: { repo: dir } } })),
    (e) => e.code === 'expose_paths_too_large',
  );
});

test('the brief lists the copies as paths a consultant can open, and the deletions apart', async () => {
  const { exposeDiff } = await import('../src/expose-paths.mjs');
  const { renderBrief } = await import('../src/brief.mjs');
  const { parseRequest } = await import('../src/schema.mjs');
  const dir = repo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-snap-'));
  const manifest = { entries: [], totals: { files: 0, bytes: 0 }, skipped: [] };
  exposeDiff(work, { repo: dir }, manifest, 20_000);
  assert.deepEqual(manifest.entries[0].paths, ['a/util.mjs', 'b/util.mjs', 'new.mjs']);
  const text = renderBrief(
    parseRequest(reviewRequest({ context: { proposal: 'p', facts: ['f'] } })),
    { round: 1, priorRounds: [] },
    manifest,
  );
  assert.match(text, /- workspace\/repo\/a\/util\.mjs\n/);
  assert.doesNotMatch(text, /workspace\/repo\/\S+ \(/);
  assert.match(text, /deleted by the change, so not copied: gone\.txt/);
});

test('a symlink is not listed as an exposed change', { skip: fileSymlinkUnavailable() }, async () => {
  const { exposeDiff } = await import('../src/expose-paths.mjs');
  const dir = repo();
  fs.symlinkSync('a/util.mjs', path.join(dir, 'link.mjs'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-snap-'));
  const manifest = { entries: [], totals: { files: 0, bytes: 0 }, skipped: [] };
  exposeDiff(work, { repo: dir }, manifest, 20_000);
  assert.ok(!manifest.entries[0].changes.some((c) => c.startsWith('link.mjs')));
});
