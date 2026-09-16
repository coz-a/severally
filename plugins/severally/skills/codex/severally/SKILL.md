---
name: severally
description: Use when a decision deserves a second, independent mind - an architectural or hard-to-reverse choice, two options that look genuinely close, or an investigation that has stalled - to get an independent opinion, review or structured debate from Claude Code or Antigravity through the severally MCP server. Also use when the user asks for it directly, in any wording - the phrases here are examples, not an exact list, and a request to ask everyone at once counts however it is phrased ("ask Claude", "get Claude to review this", "Claudeに聞いて", "Claudeにレビューしてもらって", "ask Gemini", "get Gemini to review this", "Geminiと相談して", "Geminiにレビューしてもらって", "みんなで相談して", "みんなに聞いて", "全員に聞いて", "両方に相談して", "ask everyone", "ask both", "second opinion", "セカンドオピニオン").
---

# Consulting a peer agent

You have two peers, each reached through the `severally` MCP server as a fresh child session. They can
search and browse the web. They cannot edit files, reach the network outside search/browse, load MCP tools,
see your session, or consult anyone else. In practice they know only what you put in the brief.

One caveat on that list: a consultant can read local files. Its writes and its
network access are blocked, and it starts in an empty working directory without being told where
your repository is, so in practice it answers from the brief.

## Pick the consultant

| target | Consultant | Reach for it when |
|---|---|---|
| `claude-code` | Claude Code CLI | you want a careful reading of a design or a long brief, or the decision hinges on trade-offs rather than a single fact |
| `antigravity` | Antigravity CLI (Gemini) | you want a third reading, or the question needs current web material |

`target` also accepts the everyday names: `gpt` / `chatgpt` / `openai` -> Codex, `claude` / `anthropic` ->
Claude Code, `gemini` / `agy` / `google` -> Antigravity. When the user names one, use that one. When they just
ask for a second opinion, default to `claude-code`.

Not every machine has both peers installed. `consult_start`'s description lists the consultants this one can
actually reach, and naming a missing one comes back as `target_unavailable` with the available list — take that
as final rather than retrying, and tell the user which peer is missing.

## Keep it answerable

A consultation is minutes of someone else's compute, with a hard budget: when it runs out the session is
killed and you get **nothing**, having waited. What runs out the clock is scope, not brief length. Ask one
decidable question. Do not send "research everything about X", a survey of a whole area, or three questions
at once — split those, and ask the one whose answer changes what you do next.

While it runs, `consult_get` reports `progress` (the consultant's own step trail, for the consultants that
stream it). If that shows it grinding on without converging, `consult_cancel` and ask something narrower
rather than waiting out the budget. A timeout carries the same trail in `failure.detail`, which tells you
whether to retry with a longer budget or with a smaller question.

## Naming a model

A consultant runs on the model its operator configured. If — and only if — the user names one, append it to
the target: `target: "claude-code:<model>"`, and the same inside `targets` for a fan-out. So 「Claude
Opusと相談して」 becomes `target: "claude:claude-opus-5"`. In a fan-out only the member the model was named
for carries a suffix: `targets: ["claude-code", "antigravity", "codex:<model>"]`.

Pass the model roughly as the user said it — `claude:opus` and `claude:"Claude Opus"` both resolve, as long as
they match exactly one model the operator allowed. `consult_start`'s description lists what each consultant may
run right now; a model outside that list is refused before the consultation starts, and one matching two of
them is refused rather than guessed, so a rejection tells you what to say instead.

**Do not pick a model yourself.** Without a suffix the consultant runs its default, which is the operator's
choice; overriding it on your own judgement — including after a `usage_limit` failure — substitutes a different
mind for the one the user asked for.

You may also pass `target: "codex"` to consult your own CLI in a fresh session. A fresh session of
your own lineage removes what this session has accumulated — history, sunk cost, drift toward your own framing
— but keeps what the lineage shares: training-data blind spots, the same reflexes toward the brief's wording.
So it is a clean-context re-read, not an independent opinion, and the server marks the result accordingly.
Reach for the other two when the risk is your model's blind spot; reach for this when the risk is your
session's drift — or when the user wants a **different model of your own lineage** on the question (an Opus
lead asking Fable, or the reverse, `target: "codex:<model>"`). That is a different model, not a
second lineage; the caveat stays, and it says which model answered.

Pass `caller: "codex"` in every request so the server can annotate that case, and `caller_model`
with the model you are running on when you know it (the server cannot see it). With both, the record keeps
who asked whom, and a same-vendor answer says "same model" or "different model" when the server can place
the name you gave, and otherwise relays both names without deciding.

## When this is worth it

Use it when a wrong answer is expensive or hard to undo:

- an architectural or interface decision, a data migration, a security or concurrency design
- two options that still look close after you have thought them through
- an investigation that has stalled: two or more failed attempts at the same bug with no new information
- the user asked for it

Do not use it for routine edits, formatting, a rename, a test that just needs writing, or anything you would
be comfortable defending on your own. A consultation costs a couple of minutes and real quota, so spend it on
questions where an independent answer could change what you do.

**Before you ask the user to approve a change that is hard to reverse** — a migration, a public interface, a
security or concurrency design — and nobody else has reviewed it, offer a consultation as one of the choices,
in a sentence: what you would ask, whom, and that it takes a few minutes and real quota. The user decides;
do not start one on your own, and do not offer one for a change that running the existing tests would settle.

Write down how it went, so the record can show whether offering is working at all. If the user takes the
offer, pass `initiator: "offer_accepted"` in `consult_start`; when the user asked for the consultation
themselves, pass `initiator: "user"`. If the user declines, call `consult_offer_declined({ question, would_ask })`
once and carry on -- it starts nothing and costs nothing.

## Pick the mode deliberately

| Mode | Give it | Get back |
|---|---|---|
| `explore` | objective, constraints, facts — **and not your preferred solution** | independent options, alternative framings of the problem, blind spots |
| `review` | your current proposal **and the reasoning behind it** | weaknesses, counterexamples, concrete improvements, the conditions under which it holds |
| `debate` | the disputed point, your position, the other side's claims, the extra evidence | what would change the judgement, how to test it, what disagreement remains |

`explore` is anchoring-sensitive: the server rejects a first-round `explore` that carries a proposal. That is
the point — if you want your plan critiqued, that is `review`.

**For a decision heavy enough to be worth two consultations**, ask `explore` first on the facts alone, then
`review` with the proposal, and read what the first raised that the second never did. Measured on this
project: repeat runs of the identical brief did not move the bottom line, while withholding the proposal
once did, and the withheld run was the only one to question what the decision was even about. A review
answer is organised around the proposal it was handed. Two consultations, so spend it on the decisions that
earn it.

## Before you call it

**The first consultation is small.** One consultant, `mode: "review"`, the proposal in a paragraph, the few
facts it rests on, and one diff or code excerpt:

```
consult_start({ request: {
  target: "claude-code",
  mode: "review",
  question: "the decision you are stuck on, in one sentence",
  context: { facts: ["..."], proposal: "our plan, and why", artifacts: [{name, kind, language, excerpt}] }
}})
```

That is enough to get an answer in the shape described below. Length is not what makes the answer good — a
brief that is long because it is thorough is fine, one that is long because you pasted everything buries the
question.

**For a decision you will have to live with** — an interface, a migration, a security or concurrency call —
do the organising work first; a vague brief gets a vague answer.

1. **State the question in one sentence.** Not "thoughts on this?" but the actual decision you are stuck on.
   `objective` is optional: add it only when what you are after is not already in the question.
2. **Write down what a useful answer looks like** (`success_criteria`) — e.g. "a concrete failure scenario with
   numbers, or a clear all-clear with its conditions".
3. **Supply the evidence.** The consultant starts in an empty working directory and is not told where your
   repository is, so it works from the brief alone. Put the load-bearing facts in `context.facts` and paste
   the relevant passages — the function, the failing test output, the schema, the diff — into
   `context.artifacts`. Excerpts, not whole files; the request has a character budget.
4. **Include the constraints that make cheap advice useless**: the stack, the traffic, what you cannot change.
5. **Separate imposed constraints from your own assumptions.** A constraint is read as fixed and will not be
   challenged; if "we cannot change the schema" is your call rather than a given, put it under `facts` as a
   decision with its reason, or leave it out and let the consultant test it. Only what you wrote can be doubted.
6. **Write down what you expect, before you send it.** Pass `prediction: { expected, worry }` in the request:
   the bottom line you expect (`proceed` / `do_not_proceed` / `alternative` / `undetermined`) and, in one
   sentence, the thing you are most worried about. It is stored with the consultation and **never sent to the
   consultant** — it exists so that afterwards you cannot quietly rewrite what you thought beforehand. It can
   only be written here, before the consultant runs; there is no way to add one later. Skip it when you have
   no expectation to commit to, rather than inventing one.

## Running it

```
consult_start({ request: {
  target: "claude-code",
  mode: "review",
  question: "...",
  objective: "...",                 // optional
  success_criteria: ["..."],
  constraints: ["..."],
  context: { facts: ["..."], proposal: "our plan, and why", artifacts: [{name, kind, language, excerpt}] },
  prediction: { expected: "proceed", worry: "..." },   // optional, never sent to the consultant
  followup_to: null
}})
```

Then `consult_get({ job_id, wait_ms: 45000 })` until `status` is no longer `running`. Keep working on something
independent while it runs; do not sit in a tight polling loop. `consult_cancel({ job_id })` stops it and kills
the consultant process.

## Asking two or three at once

Replace `target` with `targets: [...]` when the user names more than one peer, or when the decision is heavy
enough that you want two genuinely independent readings of it:

```
consult_start({ request: {
  targets: ["claude-code", "antigravity"],
  mode: "review",
  ...
}})
```

When the user asks for *everyone* — 「みんなで相談して」, 「全員に聞いて」, "ask everyone" — that is every
consultant this host can reach: both peers **and your own CLI** on a fresh session, three members in one
call.

```
consult_start({ request: {
  targets: ["claude-code", "antigravity", "codex"],
  mode: "review",
  ...
}})
```

Your own CLI is included because the user asked for everyone, not because it adds a lineage: it is a
fresh-context re-read rather than a third lineage, and the server says so in its `quality.caveat`. Pass
`caller_model` so that caveat can name which model answered. 「両方に相談して」 and "ask both" name two, so
those stay the two peers. Three members is the **whole concurrency cap**, so let anything else finish or
cancel it first, and expect three consultants' worth of quota. Send **one** `targets` call and poll the
single `group_id`; separate consultations would give each one a slightly different brief and leave you
nothing comparable.

Read a same-vendor answer like any other. Its `quality.caveat` lowers the weight of its *agreement* with
you; it is not a reason to discard its findings — those still stand or fall on their grounds.

Every consultant receives the **byte-identical brief** — that is the whole point, because answers to slightly
different questions are not comparable — and the server returns one `group_id` covering all of them. Poll
`consult_get({ group_id, wait_ms: 60000 })` to get every answer in one payload, and
`consult_cancel({ group_id })` to stop the whole fan-out. The payload carries `members` (each consultant's own
full result) plus `comparison.by_target`, a mechanical side-by-side of stance, summary, confidence, evidence
basis, finding points, how many findings each consultant rated high/medium/low (`severity_counts`), what each
said would change its judgement (`decision_changers`), alternatives, unknowns and remaining disagreements.
`stance` is each consultant's own one-word bottom line (`proceed` / `do_not_proceed` / `alternative` /
`undetermined`), relayed as declared.

A fan-out costs a round and real quota per consultant, and it consumes that many concurrency slots, so two is
usually enough. `targets` is refused on a follow-up: a follow-up continues the exchange with **one** consultant
(`followup_to` set to that member's `job_id`).

**Matching summaries are not agreement.** The server deliberately refuses to judge whether the consultants
agree, because inventing agreement that is not there is exactly the failure a second opinion exists to prevent.
Two agents can reach the same wording from different grounds, or from none. So:

1. **Read the `stance` column first.** Consultants that share a finding can still land on opposite bottom
   lines — "this needs sizing, then go" and "this needs sizing, so stop" cite the same fact — and a shared
   finding with opposite stances is the divergence that matters most, and the easiest to write up as
   agreement.
2. **List the divergences.** Read `comparison.by_target` and write down every point where they actually differ —
   including one naming an unknown or a risk the other never mentions.
3. **Check the grounds behind each divergence** against the code or the docs, not against whichever answer
   sounds more confident.
4. **Read `decision_changers` before spending a follow-up.** A consultant that already named the condition
   under which it would change its mind has told you what evidence to go get; that is usually cheaper than
   another round, and it is the one column that says what your next check is for.
5. **Spend a follow-up only on a divergence that would change your decision**, and send it only to the
   consultant whose reading it belongs to.

Report a divergence you could not settle as a divergence. "Both agreed" is a claim you have to earn.

## Reading the answer

The result is structured: `summary`, `stance`, `findings` (each with its grounds and impact), `alternatives`,
`unknowns`, `decision_changers`, `next_checks`, `remaining_disagreements`, `references`.

Check `status` first, and treat these as different things:

- **`failed`** — no advice was obtained. `failure.kind` says whether it was `timeout`, `auth`, `usage_limit`,
  `model_unavailable`, `invalid_output`, `cli_error` or `spawn_error`. Say so plainly and decide on your own;
  do not present a failure as "the consultant had no concerns".
- **`completed` with thin evidence** — advice arrived, but `quality.evidence_basis` is `thin`/`insufficient`,
  or `quality.caveat` flags findings that came without grounds. Weigh it accordingly.
- **`completed` with grounds** — the useful case.

Then verify before you act. Check the grounds of any finding you intend to adopt against the actual code or
docs; a peer that agrees with you is not evidence that you are right, and a confident claim about your codebase
from an agent that cannot read your codebase is a hypothesis. Wrong findings adopted uncritically cost more
than the consultation saved.

## Before you hand the decision back

The consultation is not finished when the answer arrives. Before you go back to the user with a
recommendation:

1. **Pick the one check that would change the decision.** Read `decision_changers` and `next_checks` and
   choose the one whose outcome would flip your recommendation, or would settle the finding you rate highest.
   Say why that one.
2. **Run it here, read-only.** A test, a grep, a measurement, a read of the schema or the docs. Do not edit
   anything in order to run it. If it needs another person or a production system, do not run it — say so.
3. **Come back with three things**: what you checked and what it showed; the decision you now recommend; and
   what is still unverified, point by point, so the user approves knowing what has not been confirmed.

Then write the check's verdict back, in one call. This is the record of the consultation, and it costs
nothing beyond the check you already ran:

```
consult_record({ job_id: "...", entries: [
  { id: "c1", verdict: "confirmed", effect: "the retry cap holds; recommending we proceed", note: "ran the 30 s outage test" }
]})
```

"Checked" means you ran it here. A point you only read is "unverified" in the report, however plausible it
looks. This applies to consultations about code. A consultation about a plan or a policy usually returns checks
that need other people; say so, and hand the list back unrun rather than inventing a check you can run.

## Follow-ups

By default, you get five rounds per chain: one initial round plus up to four follow-ups
(`followup_to: "<previous job_id>"`). The operator can configure 1–20 total rounds with
`SEVERALLY_MAX_ROUNDS`; use the server's reported `rounds_remaining` for the active budget. Spend
follow-ups only where you and the consultant actually diverge: quote the specific point, give the evidence that
answers it, and ask what would change their view. Stop as soon as no new evidence and no judgement-changing
argument is arriving — an early stop is a good outcome, not a missed one.

Do not push for agreement. A recorded, well-understood disagreement is a legitimate result; the answer keeps
`remaining_disagreements` for exactly that.

## Closing it out

Report to the user, briefly:

- what you **checked**, and what it showed (the section above)
- what you **adopted**, and why
- what you **rejected**, and why (this is where you push back on a finding that does not survive checking)
- what is **still unverified** — plausible, not yet checked, with the check that would settle it
- what the consultation cost: rounds used, wall-clock time, and the usage the result reports

For a routine consultation, that report plus the one recorded check is the close. **For a decision you will
have to live with**, write the rest back into the consultation too, so it is still there when the decision is
questioned a month from now:

```
consult_record({ job_id: "...", entries: [
  { id: "f1", verdict: "confirmed", effect: "capped the retries at 3", note: "reproduced with a 30s outage" },
  { id: "c1", verdict: "unverified", effect: "load test deferred to Thursday's window" }
]})
```

The job is read back from `~/.severally/history`, so a verdict can be written days later, from another
session, once the check has actually been run — write it then, not before.

If you sent a prediction, add what the answer actually added, in the same call:

```
consult_record({ job_id: "...", reflection: {
  delta: "expected the retry cap; the autovacuum cost was new to me",
  related_item_ids: ["f2"]
}})
```

There is deliberately **no hit/miss label**, and you should not invent one in your report either. A point you
predicted can still arrive with the evidence that finally settles it, and a surprise can still turn out to be
wrong — so "it matched what I expected" is not the same as "the consultation was worthless", and "it
surprised me" is not the same as "I had a blind spot". Write what changed in your understanding, or write
that nothing did, which is a real result.

The ids are the ones in the answer: findings `f1`, `f2` …, unknowns `u1` …, next_checks `c1` … . The verdict
is **what checking showed, not whether you agreed**: `confirmed` (it holds here), `not_applicable` (true in
general, not for this codebase), `unverifiable` (cannot be settled with what you can reach), `unverified` (you
have not checked it — say why in `effect`). Leaving a point unrecorded and marking it `unverified` are
different: the second is a decision you made, the first is a gap. Record the ones you checked as you check
them; `consult_get`'s `next_step` names the points still without a verdict, and recording the same id again
replaces it.

Then ask for the record and put it in the repository:

```
consult_export({ chain_id: "..." })   // or group_id for a fan-out
```

It comes back as Markdown: the brief as it was sent, each consultant's answer as it came back, and your
verdicts under the points they belong to, with the unchecked ones marked unchecked. Write it where the
decision lives (next to the code it is about, or wherever this repo keeps decision records) — the tool
returns the text and never writes a file itself. Do this only when the record is worth keeping; a routine
consultation does not need a file in the repo.

The decision, the verification and the change stay yours.
