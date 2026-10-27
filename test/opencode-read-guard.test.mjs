import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { sandboxEnv } from './helpers.mjs';

const home = sandboxEnv();
const { prepareSandbox } = await import('../src/adapters/opencode-sandbox.mjs');

test('the bundled server emits a working guard without references to bundle-local imports', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-bundled-guard-'));
  // OpenCode loads ESM plugins; the Node test loader needs an explicit format
  // on early Node 22 releases that do not perform syntax detection.
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outfile = path.join(root, 'bundled.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/adapters/opencode-read-guard.mjs', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const { writeReadGuard } = await import(pathToFileURL(outfile).href);
  writeReadGuard(root, root);
  const { default: definition } = await import(pathToFileURL(path.join(root, 'plugins/severally-read-guard.js')).href);
  const hooks = await definition.server();
  fs.writeFileSync(path.join(root, 'public.txt'), 'synthetic-public');
  const args = { path: 'public.txt' };
  await hooks['tool.execute.before']({ tool: 'read' }, { args });
  assert.equal(args.path, fs.realpathSync.native(path.join(root, 'public.txt')));
});

async function guard(t, version = 2) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-read-guard-'));
  const work = path.join(workdir, 'work');
  fs.mkdirSync(work);
  const sandbox = prepareSandbox({ workdir: work });
  fs.writeFileSync(path.join(sandbox.root, 'package.json'), '{"type":"module"}');
  t.after(() => {
    sandbox.cleanup();
    fs.rmSync(workdir, { recursive: true, force: true });
  });
  const plugin = path.join(sandbox.root, '.config', 'opencode', 'plugins', 'severally-read-guard.js');
  const { default: definition } = await import(pathToFileURL(plugin).href);
  let before;
  if (version === 2) {
    await definition.setup({
      tool: {
        async hook(event, callback) {
          assert.equal(event, 'execute.before');
          before = (tool, args) => callback({ tool, input: args });
        },
      },
    });
  } else {
    const hooks = await definition.server();
    before = (tool, args) => hooks['tool.execute.before']({ tool }, { args });
  }
  return { before, work, sandbox };
}

for (const version of [1, 2]) {
  for (const initiallyExists of [false, true]) {
    test(`OpenCode ${version} guard rechecks a protected root ${initiallyExists ? 'retargeted' : 'created'} after launch`, async (t) => {
      const credentials = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-moved-root-'));
      const previous = process.env.SEVERALLY_AGY_CRED_HOME;
      process.env.SEVERALLY_AGY_CRED_HOME = credentials;
      t.after(() => {
        process.env.SEVERALLY_AGY_CRED_HOME = previous;
        fs.rmSync(credentials, { recursive: true, force: true });
      });
      const protectedRoot = path.join(credentials, '.gemini');
      const oldTarget = path.join(credentials, 'old-target');
      fs.mkdirSync(oldTarget);
      if (initiallyExists) fs.symlinkSync(oldTarget, protectedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      const { before, work } = await guard(t, version);
      const newTarget = path.join(work, 'ordinary-store');
      fs.mkdirSync(newTarget);
      const secret = path.join(newTarget, 'credential.txt');
      fs.writeFileSync(secret, 'synthetic-secret');
      if (initiallyExists) fs.unlinkSync(protectedRoot);
      fs.symlinkSync(newTarget, protectedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(async () => before('read', { path: secret }), /severally.*denied/i);
    });
  }

  test(`OpenCode ${version} guard denies direct and relative protected paths and allows public files`, async (t) => {
    const { before, work, sandbox } = await guard(t, version);
    const secret = path.join(home, 'history', 'secret.txt');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, 'synthetic-secret');
    for (const file of [secret, path.relative(work, secret), path.join(sandbox.root, '.local/share/opencode/auth.json')]) {
      await assert.rejects(async () => before('read', { path: file }), /severally.*denied/i);
    }
    const publicFile = path.join(work, 'public.txt');
    fs.writeFileSync(publicFile, 'synthetic-public');
    const args = version === 1 ? { filePath: 'public.txt', offset: 2 } : { path: 'public.txt', offset: 2 };
    await before('read', args);
    assert.equal(args[version === 1 ? 'filePath' : 'path'], fs.realpathSync.native(publicFile));
    assert.equal(args.offset, 2);
    await before('webfetch', { url: 'https://example.com/.env' });
  });

  test(`OpenCode ${version} guard rejects malformed paths and protected filenames`, async (t) => {
    const { before, work } = await guard(t, version);
    for (const name of ['.env', '.env.production', '.npmrc', 'id_rsa']) {
      fs.writeFileSync(path.join(work, name), 'synthetic-secret');
      await assert.rejects(async () => before('read', { path: name }), /severally.*denied/i);
    }
    for (const args of [
      null,
      {},
      { path: '' },
      { path: 1 },
      { path: ['public.txt'] },
      { path: 'missing' },
      { filePath: '' },
      { path: 'a\0b' },
    ]) {
      await assert.rejects(async () => before('read', args), /severally.*denied/i);
    }
  });

  test(`OpenCode ${version} guard checks file and directory aliases on every read`, async (t) => {
    const { before, work } = await guard(t, version);
    const publicDir = path.join(work, 'public');
    fs.mkdirSync(publicDir);
    fs.writeFileSync(path.join(publicDir, 'file.txt'), 'synthetic-public');
    const alias = path.join(work, 'innocent');
    fs.symlinkSync(publicDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const allowed = { path: path.join(alias, 'file.txt') };
    await before('read', allowed);
    assert.equal(allowed.path, fs.realpathSync.native(path.join(publicDir, 'file.txt')));
    const secretDir = path.join(home, 'history');
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, 'file.txt'), 'synthetic-secret');
    fs.unlinkSync(alias);
    fs.symlinkSync(secretDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(async () => before('read', { path: path.join(alias, 'file.txt') }), /severally.*denied/i);
    await assert.rejects(async () => before('read', { path: alias }), /severally.*denied/i);
    if (process.platform !== 'win32') {
      const fileAlias = path.join(work, 'ordinary.txt');
      fs.symlinkSync(path.join(secretDir, 'file.txt'), fileAlias);
      await assert.rejects(async () => before('read', { filePath: fileAlias }), /severally.*denied/i);
    }
  });
}
