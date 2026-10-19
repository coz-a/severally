import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc, stripJsonc } from '../src/jsonc.mjs';

test('line and block comments are ignored', () => {
  const parsed = parseJsonc(`{
    // a whole line
    "targets": { /* inline */ "codex": { "enabled": false } } // trailing
  }`);
  assert.deepEqual(parsed, { targets: { codex: { enabled: false } } });
});

test('trailing commas are allowed, in objects and in arrays', () => {
  assert.deepEqual(
    parseJsonc('{ "targets": { "codex": { "models": ["a", "b",], }, }, }'),
    { targets: { codex: { models: ['a', 'b'] } } },
  );
});

// The reason this is a scanner and not a regex: a value may contain the very
// sequences being stripped.
test('what looks like a comment inside a string is data', () => {
  const parsed = parseJsonc('{ "bin": "https://example.com/agy", "note": "/* not a comment */" }');
  assert.equal(parsed.bin, 'https://example.com/agy');
  assert.equal(parsed.note, '/* not a comment */');
});

test('a comma inside a string is not a trailing comma', () => {
  assert.deepEqual(parseJsonc('{ "note": "off,}", "n": 1 }'), { note: 'off,}', n: 1 });
});

test('an escaped quote does not end the string it is in', () => {
  assert.deepEqual(parseJsonc('{ "note": "say \\" // still a string" }'), { note: 'say " // still a string' });
});

// Blanking rather than deleting keeps JSON.parse's error offsets pointing at
// the right place in the file the operator is looking at.
test('stripping preserves length and line structure', () => {
  const src = '{\n  // comment\n  "a": 1\n}';
  const stripped = stripJsonc(src);
  assert.equal(stripped.length, src.length);
  assert.equal(stripped.split('\n').length, src.split('\n').length);
});

test('plain JSON is unaffected', () => {
  const src = '{"targets":{"codex":{"enabled":true}}}';
  assert.equal(stripJsonc(src), src);
});

test('a genuinely broken file still throws', () => {
  assert.throws(() => parseJsonc('{ "targets": '), SyntaxError);
});
