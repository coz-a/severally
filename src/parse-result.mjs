// Turns whatever the consultant CLI produced into the structured result, or
// classifies it as unusable. A well-formed answer that admits it lacks evidence
// is a success with evidence_basis="thin"/"insufficient" -- that is a different
// outcome from a run that never produced a usable answer.

import { POLICY, STANCES } from './policy.mjs';
import { RESULT_KEYS } from './result-schema.mjs';
import { redactWithReport } from './redact.mjs';

export class OutputError extends Error {
  /**
   * @param {string} message
   * @param {string} [detail]
   */
  constructor(message, detail) {
    super(message);
    this.name = 'OutputError';
    this.detail = detail;
  }
}

const O = POLICY.output;

/** @typedef {'high' | 'medium' | 'low'} Level */
/** @typedef {'sufficient' | 'thin' | 'insufficient'} EvidenceBasis */
/** @typedef {(typeof STANCES)[number]} Stance */
/** @typedef {{ id: string, point: string, grounds: string | null, impact: string | null, severity: Level | null, confidence: Level | null }} Finding */
/** @typedef {{ option: string, tradeoffs: string | null, when_preferred: string | null }} Alternative */
/** @typedef {{ id: string, item: string, why_it_matters: string | null, how_to_obtain: string | null }} Unknown */
/** @typedef {{ condition: string, changes_to: string | null }} DecisionChanger */
/** @typedef {{ id: string, check: string, method: string | null, expected_signal: string | null }} NextCheck */
/** @typedef {{ topic: string, your_position: string | null, why_unresolved: string | null }} RemainingDisagreement */
/** @typedef {{ title: string | null, url: string | null, relevance: string | null }} Reference */

/**
 * The validated consult result, in the shape of CONSULT_RESULT_SCHEMA.
 * @typedef {object} ConsultResult
 * @property {string} summary
 * @property {string | null | undefined} [recommendation] Absent in older history; never inferred from summary.
 * @property {Level | null} confidence
 * @property {EvidenceBasis | null} evidence_basis
 * @property {Stance | null} stance
 * @property {Finding[]} findings
 * @property {Alternative[]} alternatives
 * @property {Unknown[]} unknowns
 * @property {DecisionChanger[]} decision_changers
 * @property {NextCheck[]} next_checks
 * @property {RemainingDisagreement[]} remaining_disagreements
 * @property {Reference[]} references
 */

/**
 * @param {unknown} v
 * @param {number} max
 * @returns {string | null}
 */
function clampText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}\n…[truncated by severally]` : t;
}

/**
 * Narrows a string to one of the listed values.
 * @template {string} T
 * @param {readonly T[]} list
 * @param {string} t
 * @returns {t is T}
 */
const oneOf = (list, t) => list.some((x) => x === t);

/** @type {Level[]} */
const LEVELS = ['high', 'medium', 'low'];
/** @type {EvidenceBasis[]} */
const BASIS = ['sufficient', 'thin', 'insufficient'];

/**
 * @param {unknown} v
 * @param {Level | null} [fallback]
 * @returns {Level | null}
 */
function level(v, fallback = null) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return oneOf(LEVELS, t) ? t : fallback;
}

/**
 * @param {unknown} v
 * @returns {EvidenceBasis | null}
 */
function basis(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return oneOf(BASIS, t) ? t : null;
}

/**
 * @param {unknown} v
 * @returns {Stance | null}
 */
function stance(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return oneOf(STANCES, t) ? t : null;
}

/**
 * Extract a JSON object from raw model text (fenced block, or first balanced object).
 * @param {unknown} text
 * @returns {Record<string, unknown> | null}
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  /** @type {string[]} */
  const candidates = [];
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  for (const [, body = ''] of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(body.trim());
  // Longest balanced {...} run as a last resort.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// `idPrefix` numbers the kept entries (f1, u1, c1 ...) so the lead can record a
// verdict against one point later. The id is ours, assigned at parse time and
// never read from the answer: a consultant that numbered its own findings
// cannot make one of them impersonate another.
/**
 * @template T
 * @param {unknown} raw
 * @param {Record<string, 'text' | 'level'>} fields
 * @param {{ requiredField: string, idPrefix?: string | null }} options
 * @returns {T[]}
 */
function mapList(raw, fields, { requiredField, idPrefix = null }) {
  if (!Array.isArray(raw)) return [];
  /** @type {T[]} */
  const out = [];
  for (const entry of raw.slice(0, O.listMax)) {
    if (!entry || typeof entry !== 'object') continue;
    /** @type {Record<string, unknown>} */
    const item = idPrefix ? { id: `${idPrefix}${out.length + 1}` } : {};
    for (const [key, kind] of Object.entries(fields)) {
      item[key] = kind === 'level' ? level(entry[key]) : clampText(entry[key], O.itemTextMax);
    }
    if (!item[requiredField]) continue;
    // Every key of `fields` is a key of T, and the required one is set.
    out.push(/** @type {T} */ (item));
  }
  return out;
}

/**
 * @param {Record<string, unknown> | string} raw  parsed JSON object, or raw text to mine one out of
 * @returns {{result: ConsultResult, quality: import('./store.mjs').Quality}}
 */
export function normalizeResult(raw) {
  const objIn = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!objIn || typeof objIn !== 'object' || Array.isArray(objIn)) {
    throw new OutputError('consultant did not return a JSON object', typeof raw === 'string' ? raw.slice(0, 2000) : String(raw));
  }
  const { value: src, redacted } = redactWithReport(objIn);

  const summary = clampText(src.summary, O.summaryMax);
  if (!summary) {
    throw new OutputError('consultant response has no usable "summary" field', JSON.stringify(src).slice(0, 2000));
  }

  /** @type {ConsultResult} */
  const result = {
    summary,
    recommendation: clampText(src.recommendation, O.itemTextMax),
    confidence: level(src.confidence),
    evidence_basis: basis(src.evidence_basis),
    stance: stance(src.stance),
    findings: mapList(
      src.findings,
      {
        point: 'text',
        grounds: 'text',
        impact: 'text',
        severity: 'level',
        confidence: 'level',
      },
      { requiredField: 'point', idPrefix: 'f' },
    ),
    alternatives: mapList(
      src.alternatives,
      {
        option: 'text',
        tradeoffs: 'text',
        when_preferred: 'text',
      },
      { requiredField: 'option' },
    ),
    unknowns: mapList(
      src.unknowns,
      {
        item: 'text',
        why_it_matters: 'text',
        how_to_obtain: 'text',
      },
      { requiredField: 'item', idPrefix: 'u' },
    ),
    decision_changers: mapList(
      src.decision_changers,
      {
        condition: 'text',
        changes_to: 'text',
      },
      { requiredField: 'condition' },
    ),
    next_checks: mapList(
      src.next_checks,
      {
        check: 'text',
        method: 'text',
        expected_signal: 'text',
      },
      { requiredField: 'check', idPrefix: 'c' },
    ),
    remaining_disagreements: mapList(
      src.remaining_disagreements,
      {
        topic: 'text',
        your_position: 'text',
        why_unresolved: 'text',
      },
      { requiredField: 'topic' },
    ),
    references: (Array.isArray(src.references) ? src.references : [])
      .slice(0, O.referencesMax)
      .map((r) =>
        r && typeof r === 'object'
          ? { title: clampText(r.title, 300), url: clampText(r.url, 1000), relevance: clampText(r.relevance, 600) }
          : { title: clampText(r, 300), url: null, relevance: null },
      )
      .filter((r) => r.title || r.url),
  };

  // The lists are cut to O.listMax before anything else looks at them; say how
  // long the ones that were cut had been, so the cut is not silent.
  const listTruncated = Object.fromEntries(
    ['findings', 'alternatives', 'unknowns', 'decision_changers', 'next_checks', 'remaining_disagreements'].flatMap((k) => {
      const v = src[k];
      return Array.isArray(v) && v.length > O.listMax ? [[k, v.length]] : [];
    }),
  );

  /** @type {Record<string, unknown>} */
  const fields = result;
  const missing = RESULT_KEYS.filter((k) => {
    const v = fields[k];
    return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  });

  // Grounds are the point of the exercise: a finding without them is not evidence.
  const groundless = result.findings.filter((f) => !f.grounds).length;

  return {
    result,
    quality: {
      redaction: { files: null, brief: null, result: redacted },
      missing_sections: missing,
      findings_without_grounds: groundless,
      unsourced: result.references.length === 0,
      ...(Object.keys(listTruncated).length ? { list_truncated: listTruncated } : {}),
    },
  };
}
