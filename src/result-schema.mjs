// The structured shape every consultation must come back in.
// Kept "strict-mode safe" (all properties required, additionalProperties:false,
// no validation keywords beyond type/enum) so it can be handed verbatim to
// Codex's --output-schema and Claude Code's --json-schema.

const s = (desc) => ({ type: 'string', description: desc });
const enumOf = (values, desc) => ({ type: 'string', enum: values, description: desc });

const obj = (properties, description) => ({
  type: 'object',
  description,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const arr = (items, description) => ({ type: 'array', description, items });

export const CONSULT_RESULT_SCHEMA = obj(
  {
    summary: s('2-6 sentence summary of your overall view, written for a peer who will act on it.'),
    confidence: enumOf(['high', 'medium', 'low'], 'Your confidence in this overall view.'),
    stance: enumOf(
      ['proceed', 'do_not_proceed', 'alternative', 'undetermined'],
      'Your bottom line on the decision the brief puts to you, in one word, so it can be placed beside other consultants\' without anyone interpreting the summaries: "proceed" (the direction as stated holds), "do_not_proceed" (it does not, as stated), "alternative" (a different direction is better -- name it under alternatives), "undetermined" (the material does not let you say).',
    ),
    evidence_basis: enumOf(
      ['sufficient', 'thin', 'insufficient'],
      'Honest self-assessment of whether the material you were given (plus anything you looked up) is enough to support this advice. Use "thin"/"insufficient" rather than guessing.',
    ),
    findings: arr(
      obj({
        point: s('The observation, weakness, counterexample or risk.'),
        grounds: s('Why you believe it: the reasoning, the passage in the brief, or the source you checked. No hand-waving.'),
        impact: s('What it costs if it is true and goes unaddressed.'),
        severity: enumOf(['high', 'medium', 'low'], 'How much it should influence the decision.'),
        confidence: enumOf(['high', 'medium', 'low'], 'How sure you are of this specific point.'),
      }),
      'Concrete points, each with its grounds and its impact. Empty array if you genuinely have none.',
    ),
    alternatives: arr(
      obj({
        option: s('An alternative approach, or an alternative framing of the problem.'),
        tradeoffs: s('What it gives up relative to the current direction.'),
        when_preferred: s('The conditions under which this option beats the current direction.'),
      }),
      'Alternatives with their trade-offs.',
    ),
    unknowns: arr(
      obj({
        item: s('Something you could not determine from the brief.'),
        why_it_matters: s('How the answer would change your advice.'),
        how_to_obtain: s('The cheapest way for the lead to resolve it.'),
      }),
      'Open questions and missing information. Do not fill these gaps with speculation elsewhere in the answer.',
    ),
    decision_changers: arr(
      obj({
        condition: s('An observation or piece of evidence that would change your judgement.'),
        changes_to: s('What your judgement would become if that condition held.'),
      }),
      'Conditions under which you would change your mind.',
    ),
    next_checks: arr(
      obj({
        check: s('The next verification worth running.'),
        method: s('How to run it concretely.'),
        expected_signal: s('What result would confirm or refute the hypothesis.'),
      }),
      'Verification steps, ordered by information gained per unit of effort.',
    ),
    remaining_disagreements: arr(
      obj({
        topic: s('The point still unresolved.'),
        your_position: s('Your position on it.'),
        why_unresolved: s('Why the exchange did not settle it.'),
      }),
      'Points where you still disagree after the exchange. Empty array if none. Never manufacture agreement to close this out.',
    ),
    references: arr(
      obj({
        title: s('Title of the source.'),
        url: s('URL, or "(brief)" when the source is material supplied in the request.'),
        relevance: s('What this source contributed to your answer.'),
      }),
      'Sources you actually consulted. Do not list sources you did not open.',
    ),
  },
  'A peer consultation response.',
);

export const RESULT_KEYS = Object.keys(CONSULT_RESULT_SCHEMA.properties);
