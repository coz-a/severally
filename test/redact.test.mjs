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
