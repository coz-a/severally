import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGuardrails } from '../src/brief.mjs';

test('consultation output guidance asks for concise, verifiable advice without hiding material evidence', () => {
  const guidance = renderGuardrails();
  assert.match(guidance, /prioriti[sz]e.*decision/i);
  assert.match(guidance, /avoid.*duplicat/i);
  assert.match(guidance, /concrete.*grounds/i);
  assert.match(guidance, /empty arrays/i);
  assert.match(guidance, /soft.*(?:limit|target)/i);
  assert.match(guidance, /do not omit.*(?:disagreement|evidence)/i);
});
