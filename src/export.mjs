// One consultation, written out as a flat Markdown record the lead can commit
// next to the code the decision was about.
//
// The point is not prettiness: it is that "what we asked, what came back, what
// we checked" survives outside ~/.severally, where a teammate -- or the same
// person in six months -- can read it in the repo. So the format is fixed, the
// sections are in a fixed order. Verification metadata is indexed up front; no answer is merged or scored on
// the way out. A round that failed is written as a failure, and a point nobody
// checked is written as unchecked; both are facts the record must not lose.

import fs from 'node:fs';
import path from 'node:path';
import { POLICY } from './policy.mjs';
import { humanSize } from './expose-paths.mjs';
import { loadRound } from './store.mjs';

/** @typedef {import('./store.mjs').Round} Round A round parsed from the history files. */
/** @typedef {import('./store.mjs').BriefRecord} BriefRecord */
/** @typedef {import('./store.mjs').JobRecord} JobRecord */

export class ExportError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

const historyDir = () => path.join(POLICY.home, 'history');

/** @param {string} p */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} chainId
 * @returns {Round[]}
 */
function roundsOf(chainId) {
  const dir = path.join(historyDir(), chainId);
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^round-\d+\.json$/.test(n))
    .sort()
    .map((n) => readJson(path.join(dir, n)))
    .filter(Boolean);
}

/** @param {Round[]} rounds */
function retryRecords(rounds) {
  const seen = new Set(rounds.map((round) => round.job_id));
  /** @type {Round[]} */
  const linked = [];
  /** @type {string[]} */
  const missing = [];
  /** @param {Round} round */
  const visit = (round) => {
    for (const jobId of [...(round.retry_context ?? []), ...(round.retry_of ? [round.retry_of] : [])]) {
      if (seen.has(jobId)) continue;
      seen.add(jobId);
      const source = loadRound(jobId);
      if (source) {
        visit(source);
        linked.push(source);
      } else missing.push(jobId);
    }
  };
  for (const round of rounds) visit(round);
  return { linked, missing };
}

// A fan-out is one question sent to several consultants, and each consultant
// answers on its own chain. Nothing in the group file records which chain that
// was, so the index -- one line per consultation -- is what maps them back.
/**
 * @param {string} groupId
 * @returns {string[]}
 */
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
  } catch {
    /* an unreadable index leaves the group unresolvable, handled below */
  }
  /** @type {string[]} */
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

/**
 * @param {string[] | null | undefined} items
 * @param {(item: string) => string} render
 */
const bullets = (items, render) => (items ?? []).map(render);

/**
 * @param {string} text
 * @param {string | null | undefined} language
 */
function fence(text, language) {
  const marker = String(text).includes('```') ? '~~~' : '```';
  return [`${marker}${language ?? ''}`, text, marker];
}

/** @param {BriefRecord | null | undefined} brief */
function briefSection(brief) {
  if (!brief) return ['*(the brief was not recorded for this round)*', ''];
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} title
   * @param {string | string[] | null | undefined} body
   */
  const block = (title, body) => {
    if (!body || (Array.isArray(body) && body.length === 0)) return;
    out.push(`**${title}**`, '');
    out.push(...(Array.isArray(body) ? body : [body]));
    out.push('');
  };
  block('Objective', brief.objective);
  block(
    'Success criteria',
    bullets(brief.success_criteria, (c) => `- ${c}`),
  );
  block(
    'Constraints',
    bullets(brief.constraints, (c) => `- ${c}`),
  );
  block(
    'Facts as given',
    bullets(brief.facts, (f) => `- ${f}`),
  );
  block('Proposal', brief.proposal);
  block(
    'Opposing claims',
    bullets(brief.counterpoints, (c) => `- ${c}`),
  );
  for (const a of brief.artifacts ?? []) {
    out.push(`**Material: ${a.name}** (${[a.kind, a.language, a.source].filter(Boolean).join(', ')})`, '');
    out.push(...fence(a.excerpt, a.language));
    out.push('');
  }
  // What the consultant could open for itself. A manifest rather than a dump:
  // the copy lived in the job directory and was deleted with it, and the files
  // have moved on since -- so the record states what was shown and where it
  // came from, which is the part a reader six months later can still act on.
  const exposed = brief.expose_paths;
  if (exposed?.entries?.length || exposed?.skipped?.length) {
    out.push('**Files exposed to the consultant**', '');
    for (const e of exposed.entries) {
      const since =
        e.changed_since_parent === undefined
          ? ''
          : e.changed_since_parent
            ? ', changed since the earlier round'
            : ', unchanged since the earlier round';
      out.push(`- ${e.exposed_as} (${e.kind}, ${e.files} file(s), ${humanSize(e.bytes)}${since}) -- from ${e.source}`);
    }
    /** @param {string} reason */
    const count = (reason) => (exposed.skipped ?? []).filter((x) => x.reason === reason).length;
    if (count('symlink')) out.push(`- ${count('symlink')} symlink(s) inside those directories were skipped, not followed`);
    if (count('protected')) out.push(`- ${count('protected')} credential or history path(s) were left out on purpose`);
    if (count('gone')) out.push(`- ${count('gone')} path(s) from the earlier round no longer existed and were not copied again`);
    if (count('masked'))
      out.push(`- ${count('masked')} path(s) from the earlier round were masked in its record and were not copied again`);
    if (count('replaced')) out.push("- the earlier round's change was replaced by the diff given in this round");
    out.push('');
  }
  return out;
}

// The lead's own line, printed under the point it belongs to. An id with no
// entry says so out loud: "nobody looked at this" is the thing a record of a
// decision most easily loses.
/**
 * @param {JobRecord | null | undefined} record
 * @param {string} id
 */
function verdictLine(record, id) {
  const entry = (record?.entries ?? []).find((e) => e.id === id);
  if (!entry) return '  - checked: no verdict recorded';
  const tail = [entry.effect, entry.note ? `(${entry.note})` : null].filter(Boolean).join(' ');
  return `  - checked: ${entry.verdict}${tail ? ` -- ${tail}` : ''}`;
}

/** @param {Round[]} rounds */
function verificationSummary(rounds) {
  const lines = [
    '## Verification summary',
    '',
    "Verdicts describe verification; effects describe the lead's decision. See each linked point for the full answer.",
    '',
  ];
  let unverified = 0;
  let checked = 0;
  for (const round of rounds) {
    const r = round.result;
    if (!r) continue;
    const points = [...r.findings, ...r.unknowns, ...r.next_checks];
    for (const point of points) {
      const entry = round.record?.entries.find((e) => e.id === point.id);
      if (!entry || !['confirmed', 'not_applicable'].includes(entry.verdict)) {
        unverified += 1;
        continue;
      }
      checked += 1;
      lines.push(
        `- [${round.job_id} / ${point.id}](#${round.job_id}-${point.id}) — ${round.target} (${round.model ?? 'model not reported'}), round ${round.round}: ${entry.verdict}`,
      );
      if (entry.effect) lines.push(`  - effect: ${entry.effect}`);
      if (entry.note) lines.push(`  - evidence: ${entry.note}`);
    }
  }
  if (!checked) lines.push('No verified points recorded.');
  lines.push(
    '',
    `Unverified points: ${unverified} (unrecorded, unverified or unverifiable). Full points and records follow.`,
    '',
  );
  return lines;
}

/** @param {Round} round */
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
  /** @type {string[]} */
  const out = [];
  const record = round.record;
  out.push('**Summary**', '', r.summary, '');
  if (r.findings.length) {
    out.push('**Findings**', '');
    for (const f of r.findings) {
      out.push(`<a id="${round.job_id}-${f.id}"></a>`, '');
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
      out.push(`<a id="${round.job_id}-${u.id}"></a>`, '');
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
      out.push(`<a id="${round.job_id}-${c.id}"></a>`, '');
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
/**
 * @param {Round} round
 * @param {BriefRecord | null} previousBrief
 */
function roundSection(round, previousBrief) {
  const secs = round.duration_ms == null ? null : (round.duration_ms / 1000).toFixed(1);
  const head = [
    `## Round ${round.round} -- ${round.target}${round.model ? ` (${round.model})` : ''}, mode ${round.mode}`,
    '',
    `- asked: ${round.created_at}${secs ? `, took ${secs}s` : ''}`,
    `- status: ${round.status}`,
    `- job_id: \`${round.job_id}\``,
    `- chain_id: \`${round.chain_id}\``,
  ];
  if (round.retry_of) head.push(`- retry_of: \`${round.retry_of}\``);
  if (round.retry_context?.length) head.push(`- retry_context: ${round.retry_context.map((id) => `\`${id}\``).join(', ')}`);
  if (round.result) {
    head.push(`- stance as declared: ${round.result.stance ?? 'not declared'}`);
    head.push(
      `- the consultant's own confidence: ${round.result.confidence ?? 'not declared'}, evidence basis: ${round.result.evidence_basis ?? 'not declared'}`,
    );
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
 * @param {{chain_id?: string | undefined, group_id?: string | undefined}} target
 * @returns {{markdown: string, rounds: number, chain_ids: string[], context_rounds?: number}}
 */
export function exportChain({ chain_id: chainId, group_id: groupId } = {}) {
  if (Boolean(chainId) === Boolean(groupId)) {
    throw new ExportError('pass exactly one of chain_id or group_id', 'export_target_required');
  }
  const chainIds = groupId ? chainsOfGroup(groupId) : chainId ? [chainId] : [];
  const perChain = chainIds.map((id) => ({ chain_id: id, rounds: roundsOf(id) }));
  const first = perChain.find((c) => c.rounds.length)?.rounds[0];
  if (!first) {
    throw new ExportError(`no consultation recorded under "${chainId ?? groupId}" in ~/.severally/history`, 'unknown_chain');
  }
  const total = perChain.reduce((n, c) => n + c.rounds.length, 0);
  const requestedRounds = perChain.flatMap((chain) => chain.rounds);
  const context = retryRecords(requestedRounds);
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
  lines.push(...verificationSummary([...requestedRounds, ...context.linked]));
  /** @type {BriefRecord | null} */
  let previousBrief = null;
  for (const chain of perChain) {
    for (const round of chain.rounds) {
      lines.push(...roundSection(round, previousBrief));
      if (round.brief) previousBrief = round.brief;
    }
  }
  if (context.linked.length || context.missing.length) {
    lines.push(
      '## Earlier retry records',
      '',
      'Historical source failures and completed context linked by the retry, not new consultations.',
      'These are the currently retained records, including later verdict updates. Prior context may have been shortened when sent.',
      '',
    );
    for (const jobId of context.missing) lines.push(`- Source job \`${jobId}\` is no longer available in retained history.`);
    lines.push('');
    for (const round of context.linked) {
      lines.push(...roundSection(round, previousBrief));
      if (round.brief) previousBrief = round.brief;
    }
  }
  return {
    markdown: `${lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()}\n`,
    rounds: total,
    chain_ids: chainIds,
    ...(context.linked.length ? { context_rounds: context.linked.length } : {}),
  };
}
