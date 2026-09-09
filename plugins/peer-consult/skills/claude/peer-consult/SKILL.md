---
name: peer-consult
description: Use when a decision deserves a second, independent mind - an architectural or hard-to-reverse choice, two options that look genuinely close, or an investigation that has stalled - to get an independent opinion, review or structured debate from Codex through the peer-consult MCP server. Also use when the user asks for it directly ("ask Codex", "get Codex to review this", "Codexに聞いて", "Codexにレビューしてもらって", "second opinion", "セカンドオピニオン").
---

# Consulting Codex

You have a peer: a fresh Codex session, reached through the `peer-consult` MCP server. It can search and
browse the web. It cannot edit files, run commands, see your session, or consult anyone else. It knows only
what you put in the brief.

## When this is worth it

Use it when a wrong answer is expensive or hard to undo:

- an architectural or interface decision, a data migration, a security or concurrency design
- two options that still look close after you have thought them through
- an investigation that has stalled: two or more failed attempts at the same bug with no new information
- the user asked for it

Do not use it for routine edits, formatting, a rename, a test that just needs writing, or anything you would
be comfortable defending on your own. A consultation costs a couple of minutes and real quota, so spend it on
questions where an independent answer could change what you do.

## Pick the mode deliberately

| Mode | Give it | Get back |
|---|---|---|
| `explore` | objective, constraints, facts — **and not your preferred solution** | independent options, alternative framings of the problem, blind spots |
| `review` | your current proposal **and the reasoning behind it** | weaknesses, counterexamples, concrete improvements, the conditions under which it holds |
| `debate` | the disputed point, your position, the other side's claims, the extra evidence | what would change the judgement, how to test it, what disagreement remains |

`explore` is anchoring-sensitive: the server rejects a first-round `explore` that carries a proposal. That is
the point — if you want your plan critiqued, that is `review`.

## Before you call it

Do the organising work yourself; a vague brief gets a vague answer.

1. **State the question in one sentence.** Not "thoughts on this?" but the actual decision you are stuck on.
2. **Write down what a useful answer looks like** (`success_criteria`) — e.g. "a concrete failure scenario with
   numbers, or a clear all-clear with its conditions".
3. **Supply the evidence.** The consultant cannot read your filesystem. Put the load-bearing facts in
   `context.facts` and paste the relevant passages — the function, the failing test output, the schema, the
   diff — into `context.artifacts`. Excerpts, not whole files; the request has a character budget.
4. **Include the constraints that make cheap advice useless**: the stack, the traffic, what you cannot change.

## Running it

```
consult_start({ request: {
  target: "codex",
  mode: "review",
  question: "...",
  objective: "...",
  success_criteria: ["..."],
  constraints: ["..."],
  context: { facts: ["..."], proposal: "our plan, and why", artifacts: [{name, kind, language, excerpt}] },
  followup_to: null
}})
```

Then `consult_get({ job_id, wait_ms: 60000 })` until `status` is no longer `running`. Keep working on something
independent while it runs; do not sit in a tight polling loop. `consult_cancel({ job_id })` stops it and kills
the consultant process.

## Reading the answer

The result is structured: `summary`, `findings` (each with its grounds and impact), `alternatives`,
`unknowns`, `decision_changers`, `next_checks`, `remaining_disagreements`, `references`.

Check `status` first, and treat these as different things:

- **`failed`** — no advice was obtained. `failure.kind` says whether it was `timeout`, `auth`, `usage_limit`,
  `model_unavailable`, `invalid_output`, `cli_error` or `spawn_error`. Say so plainly and decide on your own;
  do not present a failure as "Codex had no concerns".
- **`completed` with thin evidence** — advice arrived, but `quality.evidence_basis` is `thin`/`insufficient`,
  or `quality.caveat` flags findings that came without grounds. Weigh it accordingly.
- **`completed` with grounds** — the useful case.

Then verify before you act. Check the grounds of any finding you intend to adopt against the actual code or
docs; a peer that agrees with you is not evidence that you are right, and a confident claim about your codebase
from an agent that cannot read your codebase is a hypothesis. Wrong findings adopted uncritically cost more
than the consultation saved.

## Follow-ups

You get one initial round plus at most two follow-ups per chain (`followup_to: "<previous job_id>"`). Spend
them only where you and the consultant actually diverge: quote the specific point, give the evidence that
answers it, and ask what would change their view. Stop as soon as no new evidence and no judgement-changing
argument is arriving — an early stop is a good outcome, not a missed one.

Do not push for agreement. A recorded, well-understood disagreement is a legitimate result; the answer keeps
`remaining_disagreements` for exactly that.

## Closing it out

Report to the user, briefly:

- what you **adopted**, and why
- what you **rejected**, and why (this is where you push back on a finding that does not survive checking)
- what you are **holding** — plausible, not yet verified, with the check that would settle it
- what the consultation cost: rounds used, wall-clock time, and the usage the result reports

The decision, the verification and the change stay yours.
