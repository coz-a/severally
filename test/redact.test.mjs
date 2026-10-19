import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, containsSecret } from '../src/redact.mjs';

test('provider keys, tokens and PEM blocks are scrubbed', () => {
  const cases = [
    'sk-ant-api03-AAAABBBBCCCCDDDDEEEE',
    'sk-proj-1234567890abcdefghij',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'ANTHROPIC_API_KEY=super-secret-value-123',
    '"access_token": "ya29.a0AfH6SMB-longvaluehere"',
  ];
  for (const c of cases) {
    assert.ok(containsSecret(c), `should detect: ${c}`);
    assert.ok(!redact(c).includes('EXAMPLE') || redact(c).includes('REDACTED'), c);
    assert.match(redact(c), /REDACTED/, c);
  }
});

test('ordinary prose and code are left alone', () => {
  const text = 'The retry budget is 5 attempts; see src/retry.ts:42 and the token bucket in queue.rs.';
  assert.equal(redact(text), text);
  assert.equal(containsSecret(text), false);
});

test('nested structures are scrubbed recursively', () => {
  const out = redact({ a: ['ghp_abcdefghijklmnopqrstuvwxyz0123'], b: { c: 'fine' } });
  assert.match(out.a[0], /REDACTED/);
  assert.equal(out.b.c, 'fine');
});

test('the secrets found getting through on 2026-10-18 are scrubbed', () => {
  const cases = [
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['GCP_PRIVATE_KEY="abcdefghijklmnop"', 'abcdefghijklmnop'],
    ['STRIPE_WEBHOOK_KEY=whsec_abcdefgh12345678', 'whsec_abcdefgh'],
    ['postgres://admin:hunter2pass@db.example.com/x', 'hunter2pass'],
    ['DATABASE_URL=postgres://u:p4ssw0rdlong@h/db', 'p4ssw0rdlong'],
    ['redis://:s3cretpass@cache:6379', 's3cretpass'],
    // The vendor prefixes are joined on at run time, so the repository holds no
    // string a secret scanner reads as a real token (GitHub refuses the push).
    [`sk${'_'}live_TESTONLYnotArealKey00000`, 'TESTONLYnotArealKey00000'],
    [`npm${'_'}abcdefghijklmnopqrstuvwxyz0123456789`, 'abcdefghijklmnopqrstuvwxyz0123456789'],
    [`glpat${'-'}abcdefghij1234567890`, 'abcdefghij1234567890'],
    [`hf${'_'}abcdefghijklmnopqrstuvwxyzABCDEFGH`, 'abcdefghijklmnopqrstuvwxyzABCDEFGH'],
  ];
  for (const [c, secret] of cases) {
    assert.ok(!redact(c).includes(secret), `leaked: ${redact(c)}`);
    assert.match(redact(c), /REDACTED/, c);
  }
});

test('names that only look like keys, public keys and plain URLs are left alone', () => {
  for (const text of [
    'primary_key=organization_id',
    'sort_key: "created_at_desc"',
    'partition_key = tenant_region_id',
    'idempotency_key=request_uuid_value',
    `pk${'_'}live_TESTONLYnotArealKey00000`,
    'https://example.com:8080/path/to/thing',
    'git@github.com:owner/repo.git',
  ]) assert.equal(redact(text), text);
});

test('short passwords, Azure keys and Slack webhooks are scrubbed', () => {
  const cases = [
    ['db_pass=hunter2xyz', 'hunter2xyz'],
    ['DB_PWD=hunter2xyz', 'hunter2xyz'],
    ['db_pwd: "s3cr3t"', 's3cr3t'],
    ['password=hunter2', 'hunter2'],
    ['PASSWORD=abcd', 'abcd'],
    ['"password": "p4ss"', 'p4ss'],
    ['AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==', 'Eby8vdM02xNOcqFlqUwJ'],
    ['Endpoint=sb://x.servicebus.windows.net/;SharedAccessKey=abcdefghijklmnop1234=', 'abcdefghijklmnop1234'],
    // Joined at run time so the repository holds no string a secret scanner reads as a webhook.
    [['https://hooks.slack.com/services', 'T0123ABCD', 'B0123ABCD', 'abcdEFGH1234ijklMNOP5678'].join('/'), 'abcdEFGH1234'],
  ];
  for (const [c, secret] of cases) {
    assert.ok(!redact(c).includes(secret), `leaked: ${redact(c)}`);
    assert.match(redact(c), /REDACTED/, c);
  }
});

test('passwords that are only a flag, a type or a reference are left alone', () => {
  for (const text of [
    'password: true',
    'password = null',
    'PASSWORD=undefined',
    'password: string',
    'PWD=/home/u',
    'OLDPWD=/home/u',
    'const password = req.body.password;',
    'password = process.env.DB_PASSWORD',
    'password: os.environ["DB_PASSWORD"]',
    'DB_PASSWORD=${DB_PASSWORD}',
    'bypass=something_long',
    'primary_key=organization_id',
    'sort_key: "created_at_desc"',
  ]) assert.equal(redact(text), text);
});
