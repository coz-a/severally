import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { previewExposePaths, materializeExposedPaths, ExposeError, humanSize } =
  await import('../src/expose-paths.mjs');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Windows creates symlinks only with Developer Mode or elevation, so the
// symlink cases are probed rather than assumed -- the same tolerance
// antigravity-sandbox.mjs already applies to its credential link.
const symlinkable = (() => {
  const probe = tmp('severally-symlink-probe-');
  try {
    fs.writeFileSync(path.join(probe, 'target'), 'x');
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

test('preview: a single file is reported by size, and nothing is written', () => {
  const dir = tmp('severally-expose-');
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'hello world');

  const manifest = previewExposePaths([file]);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].kind, 'file');
  assert.equal(manifest.entries[0].files, 1);
  assert.equal(manifest.entries[0].bytes, 11);
  assert.equal(manifest.entries[0].exposedAs, 'workspace/0-note.txt');
  assert.deepEqual(manifest.totals, { files: 1, bytes: 11 });
  assert.deepEqual(fs.readdirSync(dir), ['note.txt'], 'preview must not create anything');
});

test('preview: a directory is expanded, and entries are indexed so basenames cannot collide', () => {
  const dir = tmp('severally-expose-');
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  fs.writeFileSync(path.join(dir, 'a', 'util.mjs'), 'a'.repeat(10));
  fs.writeFileSync(path.join(dir, 'b', 'util.mjs'), 'b'.repeat(20));

  const manifest = previewExposePaths([
    path.join(dir, 'a', 'util.mjs'),
    path.join(dir, 'b', 'util.mjs'),
    path.join(dir, 'a'),
  ]);
  assert.deepEqual(
    manifest.entries.map((e) => e.exposedAs),
    ['workspace/0-util.mjs', 'workspace/1-util.mjs', 'workspace/2-a'],
  );
  assert.equal(manifest.entries[2].kind, 'directory');
  assert.equal(manifest.entries[2].files, 1);
  assert.equal(manifest.totals.bytes, 10 + 20 + 10);
});

test('preview: a path that is not there is refused, by name', () => {
  const missing = path.join(tmp('severally-expose-'), 'gone.txt');
  assert.throws(
    () => previewExposePaths([missing]),
    (err) => err instanceof ExposeError && err.code === 'not_found' && err.message.includes(missing),
  );
});

test('preview: an empty or absent list is a no-op', () => {
  assert.equal(previewExposePaths([]), null);
  assert.equal(previewExposePaths(null), null);
  assert.equal(previewExposePaths(undefined), null);
});

test('preview: more files than the cap allows is refused', () => {
  const dir = tmp('severally-expose-');
  for (let i = 0; i <= 500; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
  assert.throws(
    () => previewExposePaths([dir]),
    (err) => err instanceof ExposeError && err.code === 'too_large' && /file cap/.test(err.message),
  );
});

test('preview: more bytes than the cap allows is refused', () => {
  const dir = tmp('severally-expose-');
  const big = path.join(dir, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(6_000_000, 7));
  assert.throws(
    () => previewExposePaths([big]),
    (err) => err instanceof ExposeError && err.code === 'too_large' && /MB/.test(err.message),
  );
});

test('preview: a symlink named directly is refused; one found while walking is skipped', { skip: !symlinkable }, () => {
  const dir = tmp('severally-expose-');
  const real = path.join(dir, 'real.txt');
  fs.writeFileSync(real, 'x');
  const direct = path.join(dir, 'direct-link.txt');
  fs.symlinkSync(real, direct);
  assert.throws(
    () => previewExposePaths([direct]),
    (err) => err instanceof ExposeError && err.code === 'invalid_type',
  );

  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'kept.txt'), 'kept');
  fs.symlinkSync(real, path.join(tree, 'nested-link.txt'));
  const manifest = previewExposePaths([tree]);
  assert.equal(manifest.entries[0].files, 1, 'only the real file counts');
  assert.equal(manifest.skipped.length, 1);
  assert.match(manifest.skipped[0].source, /nested-link\.txt$/);
  assert.equal(manifest.skipped[0].reason, 'symlink');
});

test('materialize: a file lands under its indexed name with its content intact', () => {
  const dir = tmp('severally-expose-');
  const workdir = tmp('severally-workdir-');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello world');

  const manifest = materializeExposedPaths(workdir, [path.join(dir, 'note.txt')]);
  assert.equal(manifest.entries[0].exposedAs, 'workspace/0-note.txt');
  assert.equal(fs.readFileSync(path.join(workdir, 'workspace', '0-note.txt'), 'utf8'), 'hello world');
});

test('materialize: a directory keeps its tree beneath the indexed folder', () => {
  const dir = tmp('severally-expose-');
  const workdir = tmp('severally-workdir-');
  fs.mkdirSync(path.join(dir, 'src', 'adapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'adapters', 'codex.mjs'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, 'src', 'top.mjs'), 'export const y = 2;');

  materializeExposedPaths(workdir, [path.join(dir, 'src')]);
  assert.equal(
    fs.readFileSync(path.join(workdir, 'workspace', '0-src', 'adapters', 'codex.mjs'), 'utf8'),
    'export const x = 1;',
  );
  assert.equal(fs.readFileSync(path.join(workdir, 'workspace', '0-src', 'top.mjs'), 'utf8'), 'export const y = 2;');
});

// Pasted excerpts are redacted on their way into the brief. A file the
// consultant opens itself must not be the way around that.
test('materialize: text is redacted on the way in, binary is copied byte-for-byte', () => {
  const dir = tmp('severally-expose-');
  const workdir = tmp('severally-workdir-');
  fs.writeFileSync(path.join(dir, 'config.env'), 'API_KEY=sk-ant-abcdefghijklmnopqrst\nPORT=8080\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));

  materializeExposedPaths(workdir, [path.join(dir, 'config.env'), path.join(dir, 'blob.bin')]);
  const text = fs.readFileSync(path.join(workdir, 'workspace', '0-config.env'), 'utf8');
  assert.match(text, /REDACTED/);
  assert.ok(!text.includes('sk-ant-abcdefghijklmnopqrst'), 'the key must not survive the copy');
  assert.match(text, /PORT=8080/, 'the rest of the file is untouched');
  assert.deepEqual(
    [...fs.readFileSync(path.join(workdir, 'workspace', '1-blob.bin'))],
    [0, 1, 2, 3, 0, 255],
  );
});

test('materialize: a path that vanished since the preview fails rather than copying half a tree', () => {
  const workdir = tmp('severally-workdir-');
  const missing = path.join(tmp('severally-expose-'), 'gone');
  assert.throws(
    () => materializeExposedPaths(workdir, [missing]),
    (err) => err instanceof ExposeError && err.code === 'not_found',
  );
});

test('humanSize reads as a size, not a number of bytes', () => {
  assert.equal(humanSize(500), '500 B');
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(humanSize(3 * 1024 * 1024), '3.0 MB');
});
