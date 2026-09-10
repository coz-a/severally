import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv } from './helpers.mjs';

sandboxEnv();
const { normalizeResult, extractJson, OutputError } = await import('../src/parse-result.mjs');

const full = {
  summary: 'S', confidence: 'medium', evidence_basis: 'sufficient', stance: 'proceed',
  findings: [{ point: 'p', grounds: 'g', impact: 'i', severity: 'low', confidence: 'high' }],
  alternatives: [{ option: 'o', tradeoffs: 't', when_preferred: 'w' }],
  unknowns: [{ item: 'u', why_it_matters: 'w', how_to_obtain: 'h' }],
  decision_changers: [{ condition: 'c', changes_to: 'ct' }],
  next_checks: [{ check: 'c', method: 'm', expected_signal: 'e' }],
  remaining_disagreements: [],
  references: [{ title: 't', url: 'https://example.com', relevance: 'r' }],
};

test('accepts a clean structured answer', () => {
  const { result, quality } = normalizeResult(full);
  assert.equal(result.summary, 'S');
  assert.equal(result.findings.length, 1);
  assert.equal(quality.findings_without_grounds, 0);
  assert.equal(quality.unsourced, false);
  assert.deepEqual(quality.missing_sections, ['remaining_disagreements']);
});

test('mines JSON out of prose and fenced blocks', () => {
  assert.equal(extractJson('here you go:\n```json\n{"a":1}\n```\nhope that helps').a, 1);
  assert.equal(extractJson('prefix {"a":{"b":2}} suffix').a.b, 2);
  assert.equal(extractJson('no json here'), null);
});

test('rejects answers with no usable summary', () => {
  assert.throws(() => normalizeResult('just prose, no json'), OutputError);
  assert.throws(() => normalizeResult({ findings: [] }), OutputError);
  assert.throws(() => normalizeResult('[1,2,3]'), OutputError);
});

test('drops malformed list entries instead of trusting them', () => {
  const { result } = normalizeResult({ ...full, findings: [{ grounds: 'orphan grounds' }, full.findings[0]], references: ['bare title'] });
  assert.equal(result.findings.length, 1);
  assert.equal(result.references[0].title, 'bare title');
});

test('unknown enum values become null rather than being coerced', () => {
  const { result } = normalizeResult({ ...full, confidence: 'very sure', evidence_basis: 'great' });
  assert.equal(result.confidence, null);
  assert.equal(result.evidence_basis, null);
});

// The stance is the consultant's own one-word bottom line. It exists so a
// fan-out can show "same finding, opposite conclusions" without anyone
// interpreting the summaries -- so it must survive normalisation verbatim,
// and an invented value must not be coerced into a real one.
test('the stance is kept as declared, and an unknown one becomes null and counts as missing', () => {
  assert.equal(normalizeResult(full).result.stance, 'proceed');
  assert.equal(normalizeResult({ ...full, stance: 'Do_Not_Proceed' }).result.stance, 'do_not_proceed');
  const { result, quality } = normalizeResult({ ...full, stance: 'strongly agree' });
  assert.equal(result.stance, null);
  assert.ok(quality.missing_sections.includes('stance'));
});
