import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sandboxEnv, waitFor, reviewRequest } from './helpers.mjs';

sandboxEnv();
const { isInstalled } = await import('../src/policy.mjs');
const { runChild, childEnv } = await import('../src/run.mjs');
const { prepareSandbox } = await import('../src/adapters/antigravity-sandbox.mjs');
const { execCommandSync, findCommand } = await import('../src/platform.mjs');
const windows = process.platform === 'win32';

test('Windows detects a CLI through PATHEXT and a backslash path', { skip: !windows }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally path 日本語 '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'consultant.CMD');
  fs.writeFileSync(bin, '@echo off\r\n');
  const original = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${original}`;
  t.after(() => { process.env.PATH = original; });
  assert.equal(isInstalled('consultant'), true);
  assert.equal(isInstalled(bin), true);
  assert.equal(isInstalled(path.join(dir, 'missing')), false);
  assert.equal(isInstalled(dir), false);
});

test('Windows launches a cmd shim with spaces and JSON arguments intact', { skip: !windows }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally path 日本語 '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'consultant.cmd');
  fs.writeFileSync(path.join(dir, 'echo.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "%~dp0echo.mjs" %*\r\n`);
  const args = ['', 'a b', '{"question":"日本語 & (review)"}', 'trailing\\', 'x|y', 'a^b', '%PATH%', '!test!'];
  const run = runChild({ command: bin, args, cwd: dir, env: childEnv('codex'), timeoutMs: 5000 });
  const result = await run.done;
  assert.equal(result.code, 0, result.spawnError || result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('Windows resolves wrappers and relative PATH entries in the requested cwd', { skip: !windows }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-cwd-'));
  const previous = process.cwd();
  t.after(() => { process.chdir(previous); fs.rmSync(dir, { recursive: true, force: true }); });
  const caller = path.join(dir, 'caller');
  const child = path.join(dir, 'child');
  for (const location of [caller, child]) {
    fs.mkdirSync(path.join(location, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(location, 'review.cmd'), `@echo ${path.basename(location)}\r\n`);
    fs.writeFileSync(path.join(location, 'bin', 'via-path.cmd'), `@echo ${path.basename(location)}\r\n`);
  }
  process.chdir(caller);
  const opts = { cwd: child, env: { ...childEnv('codex'), PATH: 'bin' } };
  assert.equal(execCommandSync('review', [], opts).trim(), 'child');
  assert.equal(execCommandSync('.\\review.cmd', [], opts).trim(), 'child');
  assert.equal(execCommandSync('via-path', [], opts).trim(), 'child');
  process.chdir(dir);
  assert.equal(findCommand('review', { ...opts, cwd: 'child' })?.toLowerCase(), path.join(child, 'review.cmd').toLowerCase());
});

function installerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-install 日本語 '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  const fake = `import fs from 'node:fs';
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.INSTALL_TEST_LOG, JSON.stringify(args) + '\\n');
    const file = process.env.INSTALL_TEST_REGISTRY;
    const registry = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const [cli, , action] = args;
    if (action === 'get') process.exitCode = registry[cli] ? 0 : 1;
    if (action === 'list' && registry[cli]) console.log('severally');
    if (action === 'add') registry[cli] = args.slice(-2);
    if (action === 'remove') delete registry[cli];
    if (action === 'add' || action === 'remove') fs.writeFileSync(file, JSON.stringify(registry));`;
  fs.writeFileSync(path.join(dir, 'cli.mjs'), fake);
  for (const cli of ['claude', 'codex', 'agy']) {
    fs.writeFileSync(path.join(dir, `${cli}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0cli.mjs" ${cli} %*\r\n`);
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const checkout = path.join(dir, 'checkout');
  for (const relative of ['scripts/install.mjs', 'src/platform.mjs', 'plugins/severally']) {
    const dest = path.join(checkout, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(root, relative), dest, { recursive: true });
  }
  for (const dependency of ['cross-spawn', 'which', 'path-key', 'shebang-command', 'shebang-regex', 'isexe']) {
    fs.cpSync(path.join(root, 'node_modules', dependency), path.join(checkout, 'node_modules', dependency), { recursive: true });
  }
  const env = { ...childEnv('codex'), PATH: dir, HOME: dir, USERPROFILE: dir,
    CODEX_HOME: path.join(dir, '.codex'), INSTALL_TEST_LOG: log,
    INSTALL_TEST_REGISTRY: path.join(dir, 'registry.json') };
  const install = (...args) => execFileSync(process.execPath, ['scripts/install.mjs', ...args], {
    cwd: checkout, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  return { dir, log, checkout, install };
}

test('Windows installation runs independently after deleting the source checkout', { skip: !windows }, async (t) => {
  const { dir, log, checkout, install } = installerFixture(t);
  install(); // No npm on PATH: the Windows install must not need it.
  const installed = path.join(dir, '.severally', 'runtime', 'severally-mcp.mjs');
  const registrations = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((args) => args[1] === 'mcp' && args[2] === 'add');
  assert.equal(registrations.length, 3);
  for (const args of registrations) {
    assert.deepEqual(args.slice(-2), [process.execPath, installed]);
  }
  for (const relative of ['.claude/skills/severally', '.codex/skills/severally', '.gemini/config/skills/severally']) {
    assert.ok(fs.existsSync(path.join(dir, relative, 'SKILL.md')));
  }
  fs.rmSync(checkout, { recursive: true, force: true });
  const client = new Client({ name: 'installed-runtime-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [installed],
      cwd: dir, env: { ...process.env, STUB_BEHAVIOR: 'ok' }, stderr: 'pipe' }));
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'consult_start'));
    const start = await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } });
    const started = JSON.parse(start.content[0].text);
    const result = await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } });
    assert.equal(JSON.parse(result.content[0].text).status, 'completed');
  } finally { await client.close(); }
});

test('Windows dry-run leaves the runtime and client skills untouched', { skip: !windows }, (t) => {
  const { dir, log, install } = installerFixture(t);
  const output = install('--dry-run');
  assert.match(output, /runtime/);
  assert.equal(fs.existsSync(path.join(dir, '.severally')), false);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args[2] === 'add' || args[2] === 'remove'), false);
});

test('Windows runtime upgrades back up the previous bundle', { skip: !windows }, (t) => {
  const { dir, checkout, install } = installerFixture(t);
  const installed = path.join(dir, '.severally', 'runtime', 'severally-mcp.mjs');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '// previous runtime\n');
  install('--skip-global', '--force');
  assert.ok(fs.readFileSync(installed).equals(
    fs.readFileSync(path.join(checkout, 'plugins', 'severally', 'dist', 'severally-mcp.mjs'))));
  const backupRoot = path.join(dir, '.severally', 'backups');
  const backups = fs.readdirSync(backupRoot).flatMap((stamp) =>
    fs.readdirSync(path.join(backupRoot, stamp)).map((name) => path.join(backupRoot, stamp, name)));
  assert.ok(backups.some((file) => fs.readFileSync(file, 'utf8') === '// previous runtime\n'));
});

test('Windows migration requires force to replace existing checkout registrations', { skip: !windows }, (t) => {
  const { dir, checkout, install } = installerFixture(t);
  const registryPath = path.join(dir, 'registry.json');
  const old = Object.fromEntries(['claude', 'codex', 'agy'].map((cli) =>
    [cli, [process.execPath, path.join(checkout, 'bin', 'severally-mcp.mjs')]]));
  fs.writeFileSync(registryPath, JSON.stringify(old));
  const output = install();
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')), old);
  assert.match(output, /Rerun with --force before deleting/);
  install('--force');
  const migrated = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  for (const cli of ['claude', 'codex', 'agy']) {
    assert.deepEqual(migrated[cli], [process.execPath, path.join(dir, '.severally', 'runtime', 'severally-mcp.mjs')]);
  }
});

test('invalid Windows bundle leaves the previous runtime and registrations intact', { skip: !windows }, (t) => {
  const { dir, checkout, log, install } = installerFixture(t);
  const installed = path.join(dir, '.severally', 'runtime', 'severally-mcp.mjs');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '// previous runtime\n');
  fs.writeFileSync(path.join(checkout, 'plugins', 'severally', 'dist', 'severally-mcp.mjs'), 'const = ;');
  assert.throws(() => install('--force'));
  assert.equal(fs.readFileSync(installed, 'utf8'), '// previous runtime\n');
  assert.equal(fs.existsSync(log), false, 'no client is called before the runtime is validated');
  assert.deepEqual(fs.readdirSync(path.dirname(installed)), ['severally-mcp.mjs']);
});

test('shipped bundle starts over stdio and completes a consultation', async (t) => {
  const client = new Client({ name: 'bundle-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../plugins/severally/dist/severally-mcp.mjs', import.meta.url))],
    env: { ...process.env, STUB_BEHAVIOR: 'ok' }, stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { reviewRequest } = await import('./helpers.mjs');
  const start = await client.callTool({ name: 'consult_start', arguments: { request: reviewRequest() } });
  const started = JSON.parse(start.content[0].text);
  const result = await client.callTool({ name: 'consult_get', arguments: { job_id: started.job_id, wait_ms: 20000 } });
  assert.equal(JSON.parse(result.content[0].text).status, 'completed');
});

test('cancellation terminates a native child and its descendant', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  let descendant;
  const source = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
  const run = runChild({ command: process.execPath, args: ['-e', source], env: childEnv('codex'), timeoutMs: 10000 });
  t.after(() => { run.handle.stop(); if (descendant) { try { process.kill(descendant); } catch {} } });
  descendant = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')));
  run.handle.stop();
  await run.done;
  await waitFor(() => { try { process.kill(descendant, 0); return false; } catch { return true; } }, { timeoutMs: 3000 });
});

test('Windows sandbox redirects native home and application config paths', { skip: !windows }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sandbox = prepareSandbox({ workdir: path.join(dir, 'work') });
  const env = childEnv('antigravity', sandbox.env);
  assert.equal(env.USERPROFILE, sandbox.root);
  assert.equal(env.HOMEDRIVE + env.HOMEPATH, sandbox.root);
  assert.equal(env.APPDATA, path.join(sandbox.root, 'AppData', 'Roaming'));
  assert.equal(env.LOCALAPPDATA, path.join(sandbox.root, 'AppData', 'Local'));
});
