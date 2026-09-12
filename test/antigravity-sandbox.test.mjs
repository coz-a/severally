import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './helpers.mjs';

// A stand-in for the operator's real ~/.gemini, so the test never touches it.
const credHome = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-cred-'));
const realTokenDir = path.join(credHome, '.gemini', 'antigravity-cli');
fs.mkdirSync(realTokenDir, { recursive: true });
fs.writeFileSync(path.join(realTokenDir, 'antigravity-oauth-token'), 'token-v1');

sandboxEnv({ PEER_CONSULT_AGY_CRED_HOME: credHome });
const { prepareSandbox } = await import('../src/adapters/antigravity-sandbox.mjs');

function makeWorkdir() {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-job-'));
  const work = path.join(job, 'work');
  fs.mkdirSync(work, { recursive: true });
  return work;
}

test('the synthesised home loads no MCP servers and denies every write path', () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });

  const mcp = fs.readFileSync(path.join(sandbox.root, '.gemini', 'config', 'mcp_config.json'), 'utf8');
  assert.deepEqual(JSON.parse(mcp), {}, 'no MCP server may be reachable: this is the recursion barrier');

  const settings = JSON.parse(
    fs.readFileSync(path.join(sandbox.root, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'),
  );
  // read_file is allowed so that all three consultants read the same amount;
  // command stays denied, so reading a file never turns into a shell.
  assert.deepEqual(settings.permissions.allow, ['read_url(*)', 'read_file(*)']);
  assert.ok(!settings.permissions.deny.includes('read_file(*)'), 'reading is not denied for this consultant');
  for (const rule of ['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)', 'unsandboxed(*)']) {
    assert.ok(settings.permissions.deny.includes(rule), `${rule} must be denied`);
  }

  assert.equal(sandbox.env.HOME, sandbox.root);
  assert.equal((fs.statSync(sandbox.root).mode & 0o777), 0o700);
  sandbox.cleanup();
});

test('the credential is linked, not copied, so a refreshed token is not stranded', () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  const link = path.join(sandbox.root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  assert.equal(sandbox.credentials, 'symlink');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(realTokenDir, 'antigravity-oauth-token')));
  assert.equal(fs.readFileSync(link, 'utf8'), 'token-v1');
  sandbox.cleanup();
});

test('cleanup removes the synthesised home and leaves the real credential alone', () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  sandbox.cleanup();
  assert.equal(fs.existsSync(sandbox.root), false);
  assert.equal(fs.readFileSync(path.join(realTokenDir, 'antigravity-oauth-token'), 'utf8'), 'token-v1');
});

test('a missing credential is reported rather than faked', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-consult-nocred-'));
  const prev = process.env.PEER_CONSULT_AGY_CRED_HOME;
  process.env.PEER_CONSULT_AGY_CRED_HOME = empty;
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  assert.equal(sandbox.credentials, 'missing');
  sandbox.cleanup();
  process.env.PEER_CONSULT_AGY_CRED_HOME = prev;
});
