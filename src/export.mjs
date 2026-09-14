// One consultation, written out as a flat Markdown record the lead can commit
// next to the code the decision was about.
//
// The point is not prettiness: it is that "what we asked, what came back, what
// we checked" survives outside ~/.severally, where a teammate -- or the same
// person in six months -- can read it in the repo. So the format is fixed, the
// sections are in a fixed order, and nothing is summarised, merged or scored on
// the way out. A round that failed is written as a failure, and a point nobody
// checked is written as unchecked; both are facts the record must not lose.

import fs from 'node:fs';
import path from 'node:path';
import { POLICY } from './policy.mjs';

export class ExportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

const historyDir = () => path.join(POLICY.home, 'history');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function roundsOf(chainId) {
  const dir = path.join(historyDir(), chainId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^round-\d+\.json$/.test(n))
    .sort()
    .map((n) => readJson(path.join(dir, n)))
    .filter(Boolean);
}

// A fan-out is one question sent to several consultants, and each consultant
// answers on its own chain. Nothing in the group file records which chain that
// was, so the index -- one line per consultation -- is what maps them back.
function chainsOfGroup(groupId) {
  const group = readJson(path.join(historyDir(), 'groups', `${groupId}.json`));
  if (!group) throw new ExportError(`no fan-out with group_id "${groupId}" in ~/.severally/history`, 'unknown_group');
  const byJob = new Map();
  try {
    for (const line of fs.readFileSync(path.join(historyDir(), 'index.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      byJob.set(row.job_id, row.chain_id);
    }
  } catch { /* an unreadable index leaves the group unresolvable, handled below */ }
  const chains = [];
  for (const jobId of group.job_ids ?? []) {
    const chainId = byJob.get(jobId);
    if (chainId && !chains.includes(chainId)) chains.push(chainId);
  }
  if (chains.length === 0) {
    throw new ExportError(`fan-out "${groupId}" has no consultation recorded in the history index`, 'unknown_group');
  }
  return chains;
}

const bullets = (items, render) => (items ?? []).map(render);

function fence(text, language) {
  const marker = String(text).includes('```') ? '~~~' : '```';
  return [`${marker}${language ?? ''}`, text, marker];
}

function briefSection(brief) {
  if (!brief) return ['*(the brief was not recorded for this round)*', ''];
  const out = [];
  const block = (title, body) => {
    if (!body || (Array.isArray(body) && body.length === 0)) return;
    out.push(`**${title}**`, '');
    out.push(...(Array.isArray(body) ? body : [body]));
    out.push('');
  };
  block('Objective', brief.objective);
  block('Success criteria', bullets(brief.success_criteria, (c) => `- ${c}`));
  block('Constraints', bullets(brief.constraints, (c) => `- ${c}`));
  block('Facts as given', bullets(brief.facts, (f) => `- ${f}`));
  block('Proposal', brief.proposal);
  block('Opposing claims', bullets(brief.counterpoints, (c) => `- ${c}`));
  for (const a of brief.artifacts ?? []) {
    out.push(`**Material: ${a.name}** (${[a.kind, a.language, a.source].filter(Boolean).join(', ')})`, '');
    out.push(...fence(a.excerpt, a.language));
    out.push('');
  }
  return out;
}

// The lead's own line, printed under the point it belongs to. An id with no
// entry says so out loud: "nobody looked at this" is the thing a record of a
// decision most easily loses.
function verdictLine(record, id) {
  const entry = (record?.entries ?? []).find((e) => e.id === id);
  if (!entry) return '  - checked: no verdict recorded';
  const tail = [entry.effect, entry.note ? `(${entry.note})` : null].filter(Boolean).join(' ');
  return `  - checked: ${entry.verdict}${tail ? ` -- ${tail}` : ''}`;
}

function answerSection(round) {
  const r = round.result;
  if (!r) {
    const f = round.failure;
    return [
      `No advice was obtained: **${f?.kind ?? 'unknown'}**${f?.message ? ` -- ${f.message}` : ''}.`,
      'This round produced no opinion at all, and must not be read as the consultant having no concerns.',
      '',
    ];
  }
  const out = [];
  const record = round.record;
  out.push('**Summary**', '', r.summary, '');
  if (r.findings.length) {
    out.push('**Findings**', '');
    for (const f of r.findings) {
      out.push(`- **${f.id}** [${f.severity ?? 'unrated'}] ${f.point}`);
      if (f.grounds) out.push(`  - grounds: ${f.grounds}`);
      if (f.impact) out.push(`  - impact: ${f.impact}`);
      out.push(verdictLine(record, f.id));
    }
    out.push('');
  }
  if (r.alternatives.length) {
    out.push('**Alternatives**', '');
    for (const a of r.alternatives) {
      out.push(`- ${a.option}`);
      if (a.tradeoffs) out.push(`  - trade-offs: ${a.tradeoffs}`);
      if (a.when_preferred) out.push(`  - preferred when: ${a.when_preferred}`);
    }
    out.push('');
  }
  if (r.unknowns.length) {
    out.push('**Unknowns**', '');
    for (const u of r.unknowns) {
      out.push(`- **${u.id}** ${u.item}`);
      if (u.why_it_matters) out.push(`  - matters because: ${u.why_it_matters}`);
      if (u.how_to_obtain) out.push(`  - obtain by: ${u.how_to_obtain}`);
      out.push(verdictLine(record, u.id));
    }
    out.push('');
  }
  if (r.decision_changers.length) {
    out.push('**Would change this judgement**', '');
    for (const d of r.decision_changers) out.push(`- ${d.condition} -> ${d.changes_to}`);
    out.push('');
  }
  if (r.next_checks.length) {
    out.push('**Checks proposed**', '');
    for (const c of r.next_checks) {
      out.push(`- **${c.id}** ${c.check}`);
      if (c.method) out.push(`  - method: ${c.method}`);
      if (c.expected_signal) out.push(`  - expected signal: ${c.expected_signal}`);
      out.push(verdictLine(record, c.id));
    }
    out.push('');
  }
  if (r.remaining_disagreements.length) {
    out.push('**Still disagreed**', '');
    for (const d of r.remaining_disagreements) {
      out.push(`- ${d.topic}: ${d.your_position ?? ''}${d.why_unresolved ? ` (${d.why_unresolved})` : ''}`);
    }
    out.push('');
  }
  if (r.references.length) {
    out.push('**Sources the consultant opened**', '');
    for (const ref of r.references) {
      out.push(`- ${[ref.title, ref.url, ref.relevance].filter(Boolean).join(' -- ')}`);
    }
    out.push('');
  }
  return out;
}

// A fan-out sends the byte-identical brief to every consultant, so printing it
// once per consultant buries the answers in repetition. Compared, not judged:
// identical text is named as identical, anything else is printed in full.
function roundSection(round, previousBrief) {
  const secs = round.duration_ms == null ? null : (round.duration_ms / 1000).toFixed(1);
  const head = [
    `## Round ${round.round} -- ${round.target}${round.model ? ` (${round.model})` : ''}, mode ${round.mode}`,
    '',
    `- asked: ${round.created_at}${secs ? `, took ${secs}s` : ''}`,
    `- status: ${round.status}`,
  ];
  if (round.result) {
    head.push(`- stance as declared: ${round.result.stance ?? 'not declared'}`);
    head.push(`- the consultant's own confidence: ${round.result.confidence ?? 'not declared'}, evidence basis: ${round.result.evidence_basis ?? 'not declared'}`);
  }
  head.push('');
  head.push('### Question', '', round.question, '');
  head.push('### Brief as sent', '');
  const same = previousBrief && JSON.stringify(previousBrief) === JSON.stringify(round.brief);
  head.push(...(same ? ['*Identical to the brief above.*', ''] : briefSection(round.brief)));
  // Printed between the brief and the answer, in the order it happened: what
  // the lead expected before reading a word of the reply.
  if (round.prediction) {
    head.push('### What the lead expected, before the answer', '');
    head.push(`- expected bottom line: ${round.prediction.expected}`);
    head.push(`- biggest worry: ${round.prediction.worry}`);
    head.push(`- written: ${round.prediction.recorded_at}`);
    head.push('');
  }
  head.push('### Answer', '');
  head.push(...answerSection(round));
  if (round.reflection) {
    head.push('### What the answer added', '');
    head.push(round.reflection.delta);
    if (round.reflection.related_item_ids?.length) {
      head.push('', `Related points: ${round.reflection.related_item_ids.join(', ')}`);
    }
    head.push('');
  }
  return head;
}

/**
 * @param {{chain_id?: string, group_id?: string}} target
 * @returns {{markdown: string, rounds: number, chain_ids: string[]}}
 */
export function exportChain({ chain_id: chainId, group_id: groupId } = {}) {
  if (Boolean(chainId) === Boolean(groupId)) {
    throw new ExportError('pass exactly one of chain_id or group_id', 'export_target_required');
  }
  const chainIds = groupId ? chainsOfGroup(groupId) : [chainId];
  const perChain = chainIds.map((id) => ({ chain_id: id, rounds: roundsOf(id) }));
  const total = perChain.reduce((n, c) => n + c.rounds.length, 0);
  if (total === 0) {
    throw new ExportError(`no consultation recorded under "${chainId ?? groupId}" in ~/.severally/history`, 'unknown_chain');
  }

  const first = perChain.find((c) => c.rounds.length)?.rounds[0];
  const lines = [
    `# Consultation record: ${first.question}`,
    '',
    `- exported: ${new Date().toISOString()}`,
    `- ${groupId ? `fan-out \`${groupId}\`, ${chainIds.length} consultant(s)` : `consultation \`${chainId}\``}`,
    '',
    'Written from `~/.severally/history`. Each round below is one consultation: the brief exactly as it was',
    'sent, the answer exactly as it came back, and under each point what the lead found when they checked it.',
    'Nothing here is summarised across consultants and nothing is scored -- where two answers point different',
    'ways, both are printed and the difference is left standing.',
    '',
  ];
  let previousBrief = null;
  for (const chain of perChain) {
    for (const round of chain.rounds) {
      lines.push(...roundSection(round, previousBrief));
      if (round.brief) previousBrief = round.brief;
    }
  }
  return { markdown: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, rounds: total, chain_ids: chainIds };
}
