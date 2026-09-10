// Turns whatever the consultant CLI produced into the structured result, or
// classifies it as unusable. A well-formed answer that admits it lacks evidence
// is a success with evidence_basis="thin"/"insufficient" -- that is a different
// outcome from a run that never produced a usable answer.

import { POLICY } from './policy.mjs';
import { RESULT_KEYS } from './result-schema.mjs';
import { redact } from './redact.mjs';

export class OutputError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'OutputError';
    this.detail = detail;
  }
}

const O = POLICY.output;

function clampText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}\n…[truncated by peer-consult]` : t;
}

const LEVELS = ['high', 'medium', 'low'];
const BASIS = ['sufficient', 'thin', 'insufficient'];
const STANCES = ['proceed', 'do_not_proceed', 'alternative', 'undetermined'];

function level(v, fallback = null) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return LEVELS.includes(t) ? t : fallback;
}

function basis(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return BASIS.includes(t) ? t : null;
}

function stance(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return STANCES.includes(t) ? t : null;
}

/** Extract a JSON object from raw model text (fenced block, or first balanced object). */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [];
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(trimmed)) !== null) candidates.push(m[1].trim());
  // Longest balanced {...} run as a last resort.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { candidates.push(trimmed.slice(start, i + 1)); break; }
      }
    }
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function mapList(raw, fields, { requiredField }) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, O.listMax)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = {};
    for (const [key, kind] of Object.entries(fields)) {
      item[key] = kind === 'level' ? level(entry[key]) : clampText(entry[key], O.itemTextMax);
    }
    if (!item[requiredField]) continue;
    out.push(item);
  }
  return out;
}

/**
 * @param {object|string} raw  parsed JSON object, or raw text to mine one out of
 * @returns {{result: object, quality: {structured_output: boolean, missing_sections: string[]}}}
 */
export function normalizeResult(raw) {
  const objIn = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!objIn || typeof objIn !== 'object' || Array.isArray(objIn)) {
    throw new OutputError('consultant did not return a JSON object', typeof raw === 'string' ? raw.slice(0, 2000) : String(raw));
  }
  const src = redact(objIn);

  const summary = clampText(src.summary, O.summaryMax);
  if (!summary) {
    throw new OutputError('consultant response has no usable "summary" field', JSON.stringify(src).slice(0, 2000));
  }

  const result = {
    summary,
    confidence: level(src.confidence),
    evidence_basis: basis(src.evidence_basis),
    stance: stance(src.stance),
    findings: mapList(src.findings, {
      point: 'text', grounds: 'text', impact: 'text', severity: 'level', confidence: 'level',
    }, { requiredField: 'point' }),
    alternatives: mapList(src.alternatives, {
      option: 'text', tradeoffs: 'text', when_preferred: 'text',
    }, { requiredField: 'option' }),
    unknowns: mapList(src.unknowns, {
      item: 'text', why_it_matters: 'text', how_to_obtain: 'text',
    }, { requiredField: 'item' }),
    decision_changers: mapList(src.decision_changers, {
      condition: 'text', changes_to: 'text',
    }, { requiredField: 'condition' }),
    next_checks: mapList(src.next_checks, {
      check: 'text', method: 'text', expected_signal: 'text',
    }, { requiredField: 'check' }),
    remaining_disagreements: mapList(src.remaining_disagreements, {
      topic: 'text', your_position: 'text', why_unresolved: 'text',
    }, { requiredField: 'topic' }),
    references: (Array.isArray(src.references) ? src.references : [])
      .slice(0, O.referencesMax)
      .map((r) => (r && typeof r === 'object'
        ? { title: clampText(r.title, 300), url: clampText(r.url, 1000), relevance: clampText(r.relevance, 600) }
        : { title: clampText(r, 300), url: null, relevance: null }))
      .filter((r) => r.title || r.url),
  };

  const missing = RESULT_KEYS.filter((k) => {
    const v = result[k];
    return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  });

  // Grounds are the point of the exercise: a finding without them is not evidence.
  const groundless = result.findings.filter((f) => !f.grounds).length;

  return {
    result,
    quality: {
      missing_sections: missing,
      findings_without_grounds: groundless,
      unsourced: result.references.length === 0,
    },
  };
}
