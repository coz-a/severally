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
  assert.deepEqual(parseJsonc('{ "targets": { "codex": { "models": ["a", "b",], }, }, }'), {
    targets: { codex: { models: ['a', 'b'] } },
  });
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

test('an unterminated block comment is rejected', () => {
  assert.throws(() => parseJsonc('0/*'), SyntaxError);
});

test('an unterminated block comment does not grow the converted text', () => {
  const src = '0/*';
  assert.equal(stripJsonc(src).length, src.length);
});

test('comma-only containers are rejected while valid trailing commas remain allowed', () => {
  assert.throws(() => parseJsonc('[,]'), SyntaxError);
  assert.throws(() => parseJsonc('{,}'), SyntaxError);
  assert.deepEqual(parseJsonc('[1,]'), [1]);
  assert.deepEqual(parseJsonc('{"a": 1,}'), { a: 1 });
});

test('comments preserve CR, LF, CRLF and CR terminates a line comment', () => {
  const lineBreaks = (text) => Array.from(text.matchAll(/\r\n?|\n/g), (match) => [match.index, match[0]]);
  const cases = [
    ['[1,//x\r2]', [1, 2]],
    ['[1,//x\n2]', [1, 2]],
    ['[1,//x\r\n2]', [1, 2]],
    ['/*\r*/0', 0],
    ['/*\n*/0', 0],
    ['/*\r\n*/0', 0],
  ];

  for (const [src, expected] of cases) {
    const stripped = stripJsonc(src);
    assert.equal(stripped.length, src.length, JSON.stringify(src));
    assert.deepEqual(lineBreaks(stripped), lineBreaks(src), JSON.stringify(src));
    assert.deepEqual(parseJsonc(src), expected, JSON.stringify(src));
  }
});

// Adopted from the actual source consultation's c1: a non-BMP comment must
// consume two UTF-16 positions while CR/LF and a later invalid token stay put.
test('non-BMP comments preserve UTF-16 error offsets and reject the original invalid input', () => {
  for (const lineBreak of ['\r', '\n', '\r\n']) {
    const source = `/*😀*/${lineBreak}[1, @]`;
    const stripped = stripJsonc(source);
    assert.equal(stripped, `      ${lineBreak}[1, @]`);
    assert.equal(stripped.length, source.length);
    assert.equal(stripped.indexOf('@'), source.indexOf('@'));
    assert.throws(() => parseJsonc(source), SyntaxError);
  }
});
