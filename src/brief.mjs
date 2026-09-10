// Renders the material that crosses the boundary between the two agents.
// Only question / assumptions / evidence / proposal / reasoning-summaries are
// exchanged. Internal chain-of-thought is neither sent nor requested.

import { POLICY } from './policy.mjs';
import { CONSULT_RESULT_SCHEMA } from './result-schema.mjs';
import { redact } from './redact.mjs';

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

const GUARDRAILS = [
  'You are an independent peer consultant for another AI coding agent ("the lead"). You give advice only.',
  '',
  'Hard rules for this session:',
  '- You must not modify, create or delete any file, and must not run shell commands, build tools or tests. Those tools are withheld from you at the process level; do not look for a way around it.',
  '- You must not start, request or delegate another consultation, sub-agent or nested agent session. This exchange ends with your answer.',
  '- You may search and browse the web freely; cite what you actually opened in `references`.',
  '- Do not read the local filesystem. Everything you are meant to have is in the brief below. If something is missing, record it under `unknowns` instead of guessing or substituting an assumption.',
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

export function renderGuardrails() {
  return GUARDRAILS.join('\n');
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

/**
 * @param {object} req validated request
 * @param {object} chain { round, priorRounds: [{question, mode, summary, keyPoints}] }
 */
export function renderBrief(req, chain = { round: 1, priorRounds: [] }) {
  const parts = [];
  parts.push(renderGuardrails());
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
  ].filter(Boolean);
  parts.push(sections.join('\n\n'));

  if (chain.priorRounds && chain.priorRounds.length) {
    parts.push('');
    parts.push('## Earlier rounds of this same consultation');
    for (const p of chain.priorRounds) {
      parts.push(
        [
          `### Round ${p.round} (${p.mode})`,
          `Question asked: ${p.question}`,
          `Your answer, summarised: ${p.summary}`,
          p.keyPoints && p.keyPoints.length ? `Points you raised: ${p.keyPoints.map((k) => `(${k})`).join(' ')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
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
