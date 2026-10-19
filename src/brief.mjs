// Renders the material that crosses the boundary between the two agents.
// Only question / assumptions / evidence / proposal / reasoning-summaries are
// exchanged. Internal chain-of-thought is neither sent nor requested.

import { POLICY } from './policy.mjs';
import { CONSULT_RESULT_SCHEMA } from './result-schema.mjs';
import { redact } from './redact.mjs';
import { humanSize } from './expose-paths.mjs';

const MODE_BRIEFS = {
  explore: [
    'MODE: explore.',
    'The lead has deliberately withheld their own preferred solution so that your thinking is not anchored to it.',
    'Work from the objective, the constraints and the facts: propose approaches you would take, name alternative framings of the problem itself, and point out what a team focused on this objective is likely to be blind to.',
    'Do not try to guess what the lead already plans to do and agree with it. Independent coverage is the entire value you add here.',
  ],
  review: [
    'MODE: review.',
    'You are given the current proposal and the reasoning behind it.',
    'Produce: the weaknesses, concrete counterexamples or failure scenarios, specific improvements, and the conditions under which the proposal actually holds.',
    'Be specific enough that the lead can act or dismiss without a follow-up round. Approving something is a legitimate outcome, but say what you checked before approving it.',
  ],
  debate: [
    'MODE: debate.',
    'You are given a disputed point, both sides as they state their own case, and the extra evidence gathered so far.',
    'Produce: what would change your judgement, how to test it, and which disagreements remain after this exchange.',
    'Do not converge for the sake of converging. If the disagreement is real, record it in remaining_disagreements with your position and why the exchange did not settle it.',
  ],
};

const GUARDRAILS_HEAD = [
  'You are an independent peer consultant for another AI coding agent ("the lead"). You give advice only.',
  '',
  'Hard rules for this session:',
  '- You must not modify, create or delete any file, and must not run build tools, tests or any command that changes state. Writes are withheld from you at the process level; do not look for a way around it.',
  '- You must not start, request or delegate another consultation, sub-agent or nested agent session. This exchange ends with your answer.',
];

// After the web bullet.
const GUARDRAILS_RULES = [
  '- When the question concerns security, it is a defensive review of the lead\'s own code or system: analyse the weaknesses and how to fix them.',
  '- The Constraints section is fixed. Design notes, drafts and internal documents among the facts and artifacts are the lead\'s current direction, not a specification, and you may question them.',
];

// The web bullet follows the request: with the network off the consultant has
// no web tools, and telling it otherwise would have it look for them.
const WEB_ON = '- You may search and browse the web freely; cite what you actually opened in `references`.';
const WEB_OFF = '- Web search and browsing are switched off for this consultation. Answer from the brief, and record what you would have looked up under `unknowns`.';

// The one bullet that depends on the request: a consultation that exposed
// paths has files, and telling it otherwise would have it record everything
// it can plainly read under `unknowns`.
const WORKDIR_EMPTY =
  '- You are running in an empty working directory and do not have the lead\'s repository; everything you are meant to have is in the brief below. If something is missing, record it under `unknowns` instead of guessing or substituting an assumption.';
const WORKDIR_EXPOSED =
  '- Your working directory is not empty: the lead exposed specific paths, listed under "Files available to you" below and copied read-only under ./workspace. Those are the only part of the lead\'s repository you have. If something you need is missing, record it under `unknowns` instead of guessing or substituting an assumption.';

const GUARDRAILS_TAIL = [
  '- Never include credentials, API keys, tokens, or environment variable values in your answer.',
  '- Do not output your internal reasoning trace. Report conclusions with their grounds and evidence.',
  '',
  'This session is time-boxed and is killed when the budget runs out, which produces no answer at all -- the',
  'lead is left with nothing, having waited. You cannot see the clock, so budget your effort instead: prefer a',
  'few well-chosen checks over exhaustive coverage, and stop gathering while you still have something to say.',
  'When you have enough to be useful, answer. A thin answer delivered beats a thorough one that never arrives:',
  'set `evidence_basis` to "thin", put what you could not verify under `unknowns`, and put the checks you would',
  'have run under `next_checks`. That is a legitimate outcome, not a failure.',
  '',
  'Output contract: reply with exactly one JSON object matching the provided schema. No prose, no markdown fences, no commentary before or after it. Empty arrays are fine; invented content is not.',
];

export function renderGuardrails(hasExposedPaths = false, network = 'on') {
  return [...GUARDRAILS_HEAD, network === 'off' ? WEB_OFF : WEB_ON, ...GUARDRAILS_RULES,
    hasExposedPaths ? WORKDIR_EXPOSED : WORKDIR_EMPTY, ...GUARDRAILS_TAIL].join('\n');
}

// The material the lead handed over, kept in the shape it was sent in. The
// rendered brief is thrown away with the job directory, so without this the
// history holds an answer whose premises are gone -- and a finding read a month
// later is only as good as the facts it was answering. Redacted the same way
// renderBrief redacts the text itself, so the stored copy is what was sent.
export function briefRecord(req, exposeManifest = null) {
  return redact({
    objective: req.objective ?? null,
    success_criteria: req.success_criteria ?? [],
    constraints: req.constraints ?? [],
    facts: req.context?.facts ?? [],
    proposal: req.context?.proposal ?? null,
    counterpoints: req.context?.counterpoints ?? [],
    artifacts: (req.context?.artifacts ?? []).map((a) => ({
      name: a.name,
      kind: a.kind,
      language: a.language ?? null,
      source: a.source ?? null,
      excerpt: a.excerpt,
    })),
    // A manifest, not a snapshot. The copy lived in the job directory and was
    // deleted with it, and the files themselves go on changing -- so what is
    // worth keeping is which paths were shown and how much of them, not a
    // frozen duplicate of a repository that has moved on since.
    expose_paths: exposeManifest
      ? {
        entries: exposeManifest.entries.map((e) => ({
          index: e.index,
          source: e.source,
          exposed_as: e.exposedAs,
          kind: e.kind,
          files: e.files,
          bytes: e.bytes,
          // What every member was handed, so a reader can check they all got the same.
          sha256: e.sha256 ?? null,
          ...(e.base ? { base: e.base, changes: e.changes } : {}),
          // A follow-up's copy of a path the parent round exposed: whether its bytes changed since.
          ...(e.changed === undefined ? {} : { changed_since_parent: e.changed }),
        })),
        totals: exposeManifest.totals,
        skipped: exposeManifest.skipped,
      }
      : null,
  });
}

function section(title, body) {
  if (!body) return null;
  return `## ${title}\n${body}`;
}

function bullets(items) {
  if (!items || items.length === 0) return null;
  return items.map((i) => `- ${i}`).join('\n');
}

function renderArtifacts(artifacts) {
  if (!artifacts.length) return null;
  return artifacts
    .map((a) => {
      const head = [`### ${a.name} (${a.kind}${a.language ? `, ${a.language}` : ''})`];
      if (a.source) head.push(`source: ${a.source}`);
      const fence = a.excerpt.includes('```') ? '~~~' : '```';
      return `${head.join('\n')}\n${fence}${a.language ?? ''}\n${a.excerpt}\n${fence}`;
    })
    .join('\n\n');
}

// How many paths inside exposed directories the brief lists, across all of
// them: enough for a reviewed module, short of crowding out the question.
const EXPOSE_LISTING_MAX = 200;

// Deleted files have no copy to open; the brief says which they were.
function deletedLines(changes = []) {
  const gone = changes.filter((c) => c.endsWith(' (deleted)')).map((c) => c.slice(0, -' (deleted)'.length));
  if (!gone.length) return [];
  const shown = gone.slice(0, 50);
  return [`  - deleted by the change, so not copied: ${shown.join(', ')}${gone.length > shown.length ? `, and ${gone.length - shown.length} more` : ''}`];
}

function renderExposeManifest(manifest) {
  if (!manifest || (manifest.entries.length === 0 && manifest.skipped.length === 0)) return null;
  let room = EXPOSE_LISTING_MAX;
  const lines = manifest.entries.flatMap((e) => {
    const shape = (e.kind === 'diff'
      ? `the files the lead's change touches, against ${e.base}, at their paths in the repository; ${e.files} copied, ${humanSize(e.bytes)}; the diff itself is among the artifacts`
      : e.kind === 'change_files'
        ? `the files the lead's change touched in the earlier round, at their paths in the repository, copied again as they are now; ${e.files} copied, ${humanSize(e.bytes)}; the diff is not repeated`
        : e.kind === 'directory'
          ? `directory, ${e.files} file(s), ${humanSize(e.bytes)}`
          : `file, ${humanSize(e.bytes)}`)
      + (e.changed === undefined ? '' : e.changed ? '; changed since the earlier round' : '; unchanged since the earlier round');
    // Not where it was copied from: the consultant is never told where the
    // lead's repository is, and Codex, Antigravity and OpenCode could read
    // the unmasked original there. The source path stays in the history.
    const paths = e.paths ?? [];
    const shown = paths.slice(0, room);
    room -= shown.length;
    return [
      `- ${e.exposedAs} (${shape})`,
      ...shown.map((p) => `  - ${e.exposedAs}/${p}`),
      ...(paths.length > shown.length ? [`  - ... ${paths.length - shown.length} more, not listed`] : []),
      ...(e.kind === 'diff' || e.kind === 'change_files' ? deletedLines(e.changes) : []),
    ];
  });
  const count = (reason) => manifest.skipped.filter((x) => x.reason === reason).length;
  const named = (reason) => manifest.skipped.filter((x) => x.reason === reason).map((x) => x.exposed_as).slice(0, 50).join(', ');
  const skipped = [
    count('symlink') ? `${count('symlink')} symlink(s), or path(s) through one, were skipped, not followed.` : null,
    count('protected') ? `${count('protected')} credential or history path(s) were left out on purpose.` : null,
    count('ignored') ? `${count('ignored')} path(s) (.git, node_modules, whatever .gitignore excludes) were left out as not source.` : null,
    count('submodule') ? `${count('submodule')} submodule(s) or nested repositor(ies) were left out; their files are not copied.` : null,
    count('gone') ? `No longer there, so not copied again: ${named('gone')}.` : null,
    count('masked') ? `Not copied again, because the record of the earlier round masked the path: ${named('masked')}.` : null,
    count('replaced') ? `The earlier round's change is replaced by the diff given in this round: ${named('replaced')}.` : null,
  ].filter(Boolean);
  if (skipped.length) skipped.unshift('');
  return [
    'The lead exposed these paths; they are copied under ./workspace in your working directory and you may read',
    'them directly. They are the only part of the lead\'s repository you have -- if you need something that is',
    'not here, record it under `unknowns` rather than guessing. Text files were passed through the same',
    'credential masking as this brief; binary files were copied unchanged.',
    '',
    ...lines,
    ...skipped,
  ].join('\n');
}

// An earlier round's point, cut to a length that keeps a five-round chain
// from crowding out the question it is there to inform.
const clip = (s, max = 400) => (s.length > max ? `${s.slice(0, max)}...` : s);

// The earlier rounds have a budget of their own, beside the request's cap:
// when they outgrow it, the oldest rounds are left out, and the brief says so.
const HISTORY_CHARS = 40_000;

function renderRound(p) {
  // Prefixed with the round, so a point from round 1 is not taken for this one's.
  const tag = (id) => `r${p.round}.${id}`;
  const verdict = (x) => (x.verdict ? ` -- lead's verdict: ${x.verdict}${x.effect ? ` (${clip(x.effect)})` : ''}` : '');
  const list = (title, items, line) => (items?.length ? [title, ...items.map(line)].join('\n') : null);
  return [
    `### Round ${p.round} (${p.mode})`,
    `Question asked: ${p.question}`,
    `Your answer, summarised: ${p.summary}`,
    list('Points you raised:', p.findings,
      (f) => `- ${tag(f.id)}: ${clip(f.point)}${verdict(f)}${f.grounds ? `\n  grounds: ${clip(f.grounds)}` : ''}`),
    list('Unknowns you named:', p.unknowns, (u) => `- ${tag(u.id)}: ${clip(u.point)}${verdict(u)}`),
    list('Checks you proposed:', p.next_checks, (c) => `- ${tag(c.id)}: ${clip(c.point)}${verdict(c)}`),
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} req validated request
 * @param {object} chain { round, priorRounds: [{question, mode, summary, findings: [{id, point, grounds, verdict, effect}],
 *   unknowns: [{id, point, verdict, effect}], next_checks: [{id, point, verdict, effect}]}] }
 */
export function renderBrief(req, chain = { round: 1, priorRounds: [] }, exposeManifest = null) {
  const parts = [];
  parts.push(renderGuardrails(Boolean(exposeManifest), req.network));
  parts.push('');
  parts.push('---');
  parts.push('');
  parts.push(`# Consultation brief (round ${chain.round} of at most ${POLICY.maxRounds})`);
  parts.push('');
  parts.push(MODE_BRIEFS[req.mode].join('\n'));
  parts.push('');

  const sections = [
    section('Question', req.question),
    section('Objective', req.objective),
    section('Success criteria for this consultation', bullets(req.success_criteria)),
    section('Constraints', bullets(req.constraints)),
    section('Established facts (supplied by the lead)', bullets(req.context.facts)),
    section(
      req.mode === 'debate' ? "The lead's position and reasoning" : 'Current proposal and the reasoning behind it',
      req.context.proposal,
    ),
    section('Opposing claims, as the other side states them', bullets(req.context.counterpoints)),
    section('Supplied material', renderArtifacts(req.context.artifacts)),
    section('Files available to you', renderExposeManifest(exposeManifest)),
  ].filter(Boolean);
  parts.push(sections.join('\n\n'));

  if (chain.priorRounds && chain.priorRounds.length) {
    parts.push('');
    parts.push('## Earlier rounds of this same consultation');
    parts.push(
      'Each point carries the lead\'s own check where there is one -- confirmed: it held; not_applicable: checked, and'
      + ' it does not apply here; unverifiable: could not be checked; unverified, or no verdict: not checked yet.',
    );
    const blocks = chain.priorRounds.map(renderRound);
    let kept = 0;
    let used = 0;
    // Newest first: the round being followed up always goes in.
    for (let i = blocks.length - 1; i >= 0 && (kept === 0 || used + blocks[i].length <= HISTORY_CHARS); i--) {
      used += blocks[i].length;
      kept += 1;
    }
    const left = chain.priorRounds.slice(0, blocks.length - kept).map((p) => p.round);
    if (left.length) parts.push(`(Round${left.length > 1 ? 's' : ''} ${left.join(', ')} left out to keep this brief within its size.)`);
    parts.push(...blocks.slice(blocks.length - kept));
    parts.push('');
    parts.push(
      'This round is a follow-up. The lead has narrowed the exchange to the divergences above. Do not restate your earlier answer; address what is new, and say plainly if the new information changes or does not change your position.',
    );
  }

  parts.push('');
  parts.push('## Response schema');
  parts.push('```json');
  parts.push(JSON.stringify(CONSULT_RESULT_SCHEMA, null, 2));
  parts.push('```');
  parts.push('');
  parts.push('Reply now with the single JSON object and nothing else.');

  return redact(parts.join('\n'));
}
