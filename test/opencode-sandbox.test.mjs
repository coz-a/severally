import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './helpers.mjs';

// A stand-in for the operator's real ~/.local/share/opencode, so the test
// never touches it.
const credHome = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-occred-'));
const realAuthDir = path.join(credHome, '.local', 'share', 'opencode');
fs.mkdirSync(realAuthDir, { recursive: true });
fs.writeFileSync(path.join(realAuthDir, 'auth.json'), '{"zai-coding-plan":{"type":"api","key":"test-key"}}');

sandboxEnv({ SEVERALLY_OPENCODE_CRED_HOME: credHome });
const { prepareSandbox } = await import('../src/adapters/opencode-sandbox.mjs');

function makeWorkdir() {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-job-'));
  const work = path.join(job, 'work');
  fs.mkdirSync(work, { recursive: true });
  return work;
}

test('the synthesised home denies every write path and allows reading and the web', () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });

  const cfg = JSON.parse(
    fs.readFileSync(path.join(sandbox.root, '.config', 'opencode', 'opencode.json'), 'utf8'),
  );
  // opencode's shipped default posture is allow-all, so the deny list is the
  // isolation: nothing that changes state may be left unspecified.
  for (const name of ['edit', 'bash', 'task', 'skill', 'lsp', 'todowrite', 'question', 'plan_enter', 'plan_exit']) {
    assert.equal(cfg.permission[name], 'deny', `${name} must be denied`);
  }
  // read tools and web stay allowed so all consultants are equal readers.
  for (const name of ['read', 'glob', 'grep', 'webfetch', 'websearch']) {
    assert.equal(cfg.permission[name], 'allow', `${name} must be allowed`);
  }
  assert.deepEqual(cfg.mcp, {}, 'no MCP server may be reachable: this is the recursion barrier');
  assert.equal(cfg.share, 'disabled', 'the session must never be uploaded');
  assert.equal(cfg.snapshot, false);
  assert.equal(cfg.autoupdate, false);
  assert.equal(cfg.tools.bash, false);
  assert.equal(cfg.tools.edit, false);

  assert.equal(sandbox.env.HOME, sandbox.root);
  assert.equal(sandbox.env.XDG_CONFIG_HOME, path.join(sandbox.root, '.config'));
  assert.equal(sandbox.env.XDG_DATA_HOME, path.join(sandbox.root, '.local', 'share'));
  assert.equal(sandbox.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  // Windows uses ACLs and cannot represent Unix owner-only mode bits.
  if (process.platform !== 'win32') assert.equal((fs.statSync(sandbox.root).mode & 0o777), 0o700);
  sandbox.cleanup();
});

test('the credential is linked when permitted, with a copy fallback', () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  const link = path.join(sandbox.root, '.local', 'share', 'opencode', 'auth.json');
  if (sandbox.credentials === 'symlink') {
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(realAuthDir, 'auth.json')));
  } else {
    assert.equal(sandbox.credentials, 'copy');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  }
  assert.ok(fs.readFileSync(link, 'utf8').includes('test-key'));
  sandbox.cleanup();
});

test('cleanup removes the synthesised home and leaves the real credential alone', () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  sandbox.cleanup();
  assert.equal(fs.existsSync(sandbox.root), false);
  assert.ok(fs.readFileSync(path.join(realAuthDir, 'auth.json'), 'utf8').includes('test-key'));
});

test('a missing credential is reported rather than faked', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-nocred-'));
  const prev = process.env.SEVERALLY_OPENCODE_CRED_HOME;
  process.env.SEVERALLY_OPENCODE_CRED_HOME = empty;
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  assert.equal(sandbox.credentials, 'missing');
  assert.equal(sandbox.credentialsSource, path.join(empty, '.local', 'share', 'opencode', 'auth.json'));
  sandbox.cleanup();
  process.env.SEVERALLY_OPENCODE_CRED_HOME = prev;
});
