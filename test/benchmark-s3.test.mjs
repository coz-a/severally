import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareS3Material, verifyS3Material } from '../scripts/benchmark-s3.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 's3-repo-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export const x = 1;\n');
  git('add', 'source.mjs');
  git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'fixture');
  const file = path.join(repo, 'source.mjs');
  const bytes = fs.readFileSync(file);
  const manifest = {
    request: { context: { expose_paths: [file] } },
    material: { repo, commit: git('rev-parse', 'HEAD'), files: [{ path: 'source.mjs', sha256: sha(bytes) }] },
  };
  const start = {
    exposed_material: {
      totals: { files: 1, bytes: bytes.length },
      entries: [
        { source: file, kind: 'file', files: 1, bytes: bytes.length, sha256: sha(Buffer.concat([Buffer.from('\0'), bytes])) },
      ],
      skipped: [],
    },
  };
  return { repo, file, manifest, start, git };
}

test('S3 validates a fixed clean repository and the actual copied bytes', () => {
  const { manifest, start } = fixture();
  const prepared = prepareS3Material(manifest);
  assert.equal(prepared.files.length, 1);
  assert.equal(verifyS3Material(prepared, start).verified, true);
  start.exposed_material.entries[0].sha256 = '0'.repeat(64);
  assert.throws(() => verifyS3Material(prepared, start), /copied.*match/i);
});

test('S3 refuses changed files, untracked paths and a changed request before launch', () => {
  const { repo, file, manifest } = fixture();
  fs.writeFileSync(file, 'changed');
  assert.throws(() => prepareS3Material(manifest), /clean|changed/i);
  fs.writeFileSync(file, 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'other.mjs'), 'untracked');
  assert.throws(() => prepareS3Material(manifest), /clean|untracked/i);
  fs.unlinkSync(path.join(repo, 'other.mjs'));
  manifest.request.context.expose_paths = [];
  assert.throws(() => prepareS3Material(manifest), /expose_paths/i);
});

test('S3 refuses traversal and symbolic-link material', (t) => {
  const { repo, manifest } = fixture();
  manifest.material.files[0].path = '../outside';
  assert.throws(() => prepareS3Material(manifest), /relative|outside|path/i);
  manifest.material.files[0].path = 'link.mjs';
  const link = path.join(repo, 'link.mjs');
  try {
    fs.symlinkSync(path.join(repo, 'source.mjs'), link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.diagnostic(`file symlink unavailable: ${error.code}; traversal was still checked`);
      return;
    }
    throw error;
  }
  assert.throws(() => prepareS3Material(manifest), /clean|symlink|untracked/i);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`S3 compares selected bytes to HEAD with ${flag}`, () => {
    const { file, manifest, git } = fixture();
    git('update-index', flag, 'source.mjs');
    fs.writeFileSync(file, 'export const x = 2;\n');
    manifest.material.files[0].sha256 = sha(fs.readFileSync(file));
    assert.throws(() => prepareS3Material(manifest), /HEAD|tracked/i);
  });
}

test('S3 treats bracket characters in selected file names literally', () => {
  const { repo, manifest, git } = fixture();
  const filename = 'source[1].mjs';
  const file = path.join(repo, filename);
  fs.writeFileSync(file, 'export const x = 2;\n');
  git('add', '--', `:(literal)${filename}`);
  git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'bracket file');
  manifest.material.commit = git('rev-parse', 'HEAD');
  manifest.material.files = [{ path: filename, sha256: sha(fs.readFileSync(file)) }];
  manifest.request.context.expose_paths = [file];
  assert.equal(prepareS3Material(manifest).files[0].path, filename);
});

test('S3 cannot mistake a wildcard match for a tracked literal path', () => {
  const { repo, manifest, git } = fixture();
  fs.writeFileSync(path.join(repo, 'source1.mjs'), 'tracked\n');
  git('add', '--', 'source1.mjs');
  git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'tracked file');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\nsource[[]1].mjs\n');
  const untracked = path.join(repo, 'source[1].mjs');
  fs.writeFileSync(untracked, 'untracked\n');
  manifest.material.commit = git('rev-parse', 'HEAD');
  manifest.material.files = [{ path: 'source[1].mjs', sha256: sha(fs.readFileSync(untracked)) }];
  manifest.request.context.expose_paths = [untracked];
  assert.throws(() => prepareS3Material(manifest), /tracked|material/i);
});
