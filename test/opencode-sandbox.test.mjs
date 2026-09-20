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
const { prepareSandbox, seedCredentialFromAuth } = await import('../src/adapters/opencode-sandbox.mjs');

// node:sqlite ships unflagged from Node 23 (and late 22.x); the engines field
// allows older runtimes, where seeding degrades to a no-op -- and these tests
// with it.
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }

// The schema a failed `opencode run` leaves behind on 2.x: the migrations
// have run, so the credential table exists even though the run never
// authenticated.
function bootstrapCredentialTable(sandbox) {
  const dir = path.join(sandbox.root, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec('CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)');
  db.close();
}

function credentialRows(sandbox) {
  const db = new sqlite.DatabaseSync(path.join(sandbox.root, '.local', 'share', 'opencode', 'opencode.db'), { readOnly: true });
  const rows = db.prepare('SELECT integration_id, label, value FROM credential').all();
  db.close();
  return rows;
}

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
  // isolation: nothing that changes state may be left unspecified. The list
  // carries both name generations -- 1.x (bash, task) and 2.x (shell,
  // subagent) -- because 2.x normalises the old names but a future version
  // may drop the aliases.
  for (const name of ['edit', 'bash', 'task', 'skill', 'lsp', 'todowrite', 'question', 'plan_enter', 'plan_exit', 'shell', 'subagent']) {
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

test('the credential is copied into the sandbox as a regular file, never linked', () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  const link = path.join(sandbox.root, '.local', 'share', 'opencode', 'auth.json');
  assert.equal(sandbox.credentials, 'copy');
  assert.equal(
    fs.lstatSync(link).isSymbolicLink(),
    false,
    'a CLI-side credential refresh (2.x rewrites auth.json in place) must not write through to the real store',
  );
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

// opencode 2.x authenticates from the credential table in the session
// database, not from auth.json (that is 1.x). A failed run has already
// created the schema, so seeding the row the CLI would have written lets the
// retry authenticate. The value shape was copied from a live 2.0.11
// `opencode auth login` row: {"type":"key","key":...} -- note "key", not the
// "api" auth.json uses.
test('seedCredentialFromAuth writes the 2.x credential row from the copied auth.json', { skip: !sqlite }, () => {
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  bootstrapCredentialTable(sandbox);
  assert.equal(seedCredentialFromAuth(sandbox, 'zai-coding-plan'), true);
  assert.deepEqual(
    credentialRows(sandbox).map((r) => ({ integration_id: r.integration_id, label: r.label, value: r.value })),
    [{ integration_id: 'zai-coding-plan', label: 'API key', value: '{"type":"key","key":"test-key"}' }],
  );
  sandbox.cleanup();
});

test('seedCredentialFromAuth refuses what it cannot seed honestly', { skip: !sqlite }, () => {
  // A provider the operator has no auth.json entry for.
  const sandbox = prepareSandbox({ workdir: makeWorkdir() });
  bootstrapCredentialTable(sandbox);
  assert.equal(seedCredentialFromAuth(sandbox, 'some-other-provider'), false);
  assert.deepEqual(credentialRows(sandbox), []);
  sandbox.cleanup();

  // A database the CLI never bootstrapped: creating one ourselves would
  // race the CLI's own migrations, so seeding is skipped instead.
  const fresh = prepareSandbox({ workdir: makeWorkdir() });
  assert.equal(seedCredentialFromAuth(fresh, 'zai-coding-plan'), false);
  fresh.cleanup();
});

// A fresh 2.x installation may hold its credentials only in the operator's
// session database, with no auth.json at all. The seed then reads that one
// provider's row from the real database -- read-only, never a copy of the
// whole store -- and writes it into the sandbox database verbatim, because
// it is already the CLI's own format.
test('seedCredentialFromAuth falls back to the operator database when auth.json is absent', { skip: !sqlite }, () => {
  const dbOnlyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-dbonly-'));
  const operatorDbDir = path.join(dbOnlyHome, '.local', 'share', 'opencode');
  fs.mkdirSync(operatorDbDir, { recursive: true });
  const operatorDb = new sqlite.DatabaseSync(path.join(operatorDbDir, 'opencode.db'));
  operatorDb.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)');
  operatorDb.prepare('INSERT INTO credential (id, integration_id, label, value) VALUES (?, ?, ?, ?)')
    .run('cred_operator', 'zai-coding-plan', 'API key', '{"type":"key","key":"db-only-key"}');
  operatorDb.close();

  const prev = process.env.SEVERALLY_OPENCODE_CRED_HOME;
  process.env.SEVERALLY_OPENCODE_CRED_HOME = dbOnlyHome;
  try {
    const sandbox = prepareSandbox({ workdir: makeWorkdir() });
    assert.equal(sandbox.credentials, 'missing', 'no auth.json exists to copy');
    bootstrapCredentialTable(sandbox);
    assert.equal(seedCredentialFromAuth(sandbox, 'zai-coding-plan'), true);
    assert.deepEqual(
      credentialRows(sandbox).map((r) => r.value),
      ['{"type":"key","key":"db-only-key"}'],
      'the operator row must arrive verbatim, not re-encoded',
    );
    sandbox.cleanup();
  } finally {
    process.env.SEVERALLY_OPENCODE_CRED_HOME = prev;
  }
  fs.rmSync(dbOnlyHome, { recursive: true, force: true });
});

// The database is what the 2.x CLI itself authenticates with, so it wins over
// a copied auth.json: an operator who rotated their key through `auth login`
// can be left with a stale auth.json entry, and seeding that would fail the
// single retry while the working key sat unread. Among several database rows
// the most recently updated one is the live credential.
test('the operator database outranks a stale auth.json entry, latest row first', { skip: !sqlite }, () => {
  const mixedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-mixed-'));
  const dir = path.join(mixedHome, '.local', 'share', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"zai-coding-plan":{"type":"api","key":"stale-key"}}');
  const operatorDb = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
  operatorDb.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)');
  const insert = operatorDb.prepare('INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('cred_old', 'zai-coding-plan', 'API key', '{"type":"key","key":"old-rotated-away"}', 1, 1);
  insert.run('cred_live', 'zai-coding-plan', 'API key', '{"type":"key","key":"live-key"}', 2, 3);
  operatorDb.close();

  const prev = process.env.SEVERALLY_OPENCODE_CRED_HOME;
  process.env.SEVERALLY_OPENCODE_CRED_HOME = mixedHome;
  try {
    const sandbox = prepareSandbox({ workdir: makeWorkdir() });
    bootstrapCredentialTable(sandbox);
    assert.equal(seedCredentialFromAuth(sandbox, 'zai-coding-plan'), true);
    assert.deepEqual(
      credentialRows(sandbox).map((r) => r.value),
      ['{"type":"key","key":"live-key"}'],
      'the live database credential must outrank the stale auth.json entry',
    );
    sandbox.cleanup();
  } finally {
    process.env.SEVERALLY_OPENCODE_CRED_HOME = prev;
  }
  fs.rmSync(mixedHome, { recursive: true, force: true });
});
