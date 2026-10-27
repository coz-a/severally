import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SEVERALLY_KILL_GRACE_MS = '1000';
const { runChild } = await import('../src/run.mjs');

for (const mode of ['timeout', 'cancel'])
  test(`${mode} settles within one kill grace when an exited child leaves its output pipes open`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-deadline-'));
    const pidFile = path.join(dir, 'descendant.pid');
    t.after(() => {
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid);
          } catch {
            // The descendant has already exited.
          }
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    // The parent exits, but its detached child keeps the parent's stdout pipe.
    const source = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
      {stdio:['ignore','inherit','inherit'],detached:true,windowsHide:true});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref();`;
    const start = Date.now();
    let cancel;
    const run = runChild({
      command: process.execPath,
      args: ['-e', source],
      timeoutMs: mode === 'timeout' ? 300 : 10_000,
      onCancelSignal: (fn) => {
        cancel = fn;
      },
    });
    if (mode === 'cancel') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      cancel();
    }
    const result = await run.done;
    const elapsed = Date.now() - start;
    assert.ok(fs.existsSync(pidFile), 'the parent created the pipe-holding descendant');
    assert.equal(result.timedOut, mode === 'timeout');
    assert.equal(result.cancelled, mode === 'cancel');
    assert.equal(result.pipesForced, true);
    assert.ok(elapsed < 1800, `timeout and one grace should settle before 1800 ms; observed ${elapsed} ms`);
  });
