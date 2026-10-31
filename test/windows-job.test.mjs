import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sandboxEnv, waitFor } from './helpers.mjs';

sandboxEnv();
const { runChild, childEnv } = await import('../src/run.mjs');
const windows = process.platform === 'win32';

test('Windows unresolved commands fail without launching an unmanaged process', { skip: !windows }, async () => {
  for (const command of [
    'severally-nonexistent-command-019fe3',
    path.join(os.tmpdir(), 'severally-no-such-executable-019fe3.exe'),
  ]) {
    const run = runChild({ command, args: [], env: childEnv('codex'), timeoutMs: 10000 });
    assert.equal(run.pid, undefined);
    const result = await run.done;
    assert.match(result.spawnError, /ENOENT/);
    assert.equal(result.code, null);
  }
});

for (const keepsPipes of [false, true])
  test(
    `Windows closes the launch job after the CLI exits, stopping detached descendants (${keepsPipes ? 'inherited' : 'closed'} pipes) without using their PID`,
    { skip: !windows },
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-job-cleanup-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const beat = path.join(dir, 'heartbeat');
      const descendant = `const fs=require('fs');const p=${JSON.stringify(beat)};fs.appendFileSync(p,'x');setInterval(()=>fs.appendFileSync(p,'x'),100);setTimeout(()=>process.exit(0),10000);`;
      const source = `const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:${keepsPipes ? "['ignore','inherit','inherit']" : "'ignore'"},detached:true,windowsHide:true});c.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);process.exit(0)}},20);`;
      const run = runChild({ command: process.execPath, args: ['-e', source], env: childEnv('codex'), timeoutMs: 15000 });
      const result = await run.done;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.pipesForced, false, 'closing the Job releases descendant pipes without the orphan grace');
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      await waitFor(() => fs.existsSync(beat), { timeoutMs: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const before = fs.statSync(beat).size;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(fs.statSync(beat).size, before, 'descendant heartbeat must stop when the launch job closes');
    },
  );

test(
  'Windows managed launch preserves stdin, Unicode arguments, stdout, stderr and exit status',
  { skip: !windows },
  async () => {
    const args = ['space here', 'quote"here', '日本語😀', 'trailing\\'];
    const code = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:s}));process.stderr.write('expected stderr');process.exit(7)});`;
    const run = runChild({
      command: process.execPath,
      args: ['-e', code, ...args],
      env: childEnv('codex'),
      input: 'input 😀\n',
      timeoutMs: 15000,
    });
    const result = await run.done;
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, input: 'input 😀\n' });
    assert.equal(result.stderr, 'expected stderr');
  },
);

test('Windows managed launch keeps forwarding cmd shim quoting', { skip: !windows }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally job 日本語 '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'echo.cjs');
  const shim = path.join(dir, 'echo.cmd');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  // A cmd file is decoded using its codepage; %~dp0 keeps the file ASCII
  // while still exercising a Unicode directory through CreateProcessW.
  fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0echo.cjs" %*\r\n`);
  const args = ['space here', 'quote"here', 'a&b', '%PATH%', 'caret^here', '日本語'];
  const result = await runChild({ command: shim, args, env: childEnv('codex'), timeoutMs: 15000 }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('Windows managed launch preserves a large Unicode stdin payload and unsigned exit status', { skip: !windows }, async () => {
  const input = '日本語😀 abc\n'.repeat(100000);
  const code = `const {createHash}=require('crypto');const h=createHash('sha256');process.stdin.on('data',x=>h.update(x));process.stdin.on('end',()=>{process.stdout.write(h.digest('hex'));process.exit(0xc0000005)});`;
  const result = await runChild({
    command: process.execPath,
    args: ['-e', code],
    env: childEnv('codex'),
    input,
    timeoutMs: 20000,
  }).done;
  assert.equal(result.stdout, createHash('sha256').update(input).digest('hex'), result.stderr);
  assert.equal(result.code, 0xc0000005);
});

test('Windows timeout stops a detached descendant before releasing the run', { skip: !windows }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-job-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const beat = path.join(dir, 'heartbeat');
  const descendant = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),50);setTimeout(()=>process.exit(0),15000);`;
  const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:true});setInterval(()=>{},1000);`;
  const run = runChild({ command: process.execPath, args: ['-e', code], env: childEnv('codex'), timeoutMs: 2500 });
  await waitFor(() => fs.existsSync(beat), { timeoutMs: 2000 });
  const result = await run.done;
  assert.equal(result.timedOut, true);
  const before = fs.statSync(beat).size;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fs.statSync(beat).size, before);
});

// No model or UI automation: query the console attached to an ordinary grandchild.
test('Windows ordinary grandchildren do not acquire a visible console', { skip: !windows }, async () => {
  const ps = `Add-Type -Name ConsoleProbe -Namespace Severally -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'; [Console]::Write([Severally.ConsoleProbe]::IsWindowVisible([Severally.ConsoleProbe]::GetConsoleWindow()))`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const code = `const c=require('child_process').spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',${JSON.stringify(encoded)}],{stdio:['ignore','pipe','pipe']});c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);c.on('close',n=>process.exit(n));`;
  const result = await runChild({ command: process.execPath, args: ['-e', code], env: childEnv('codex'), timeoutMs: 15000 }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'False');
});
