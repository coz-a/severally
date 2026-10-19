# severally: the rest of the record

`SKILL.md` covers the normal consultation: start, wait, check one point, record it. Read this file for a
decision you will have to justify later, for a follow-up, or for the details of reading several answers at once.

## Modes

| Mode | Give it | Get back |
|---|---|---|
| `explore` | objective, constraints, facts — **and not your preferred solution** | independent options, alternative framings of the problem, blind spots |
| `review` | your current proposal **and the reasoning behind it** | weaknesses, counterexamples, concrete improvements, the conditions under which it holds |
| `debate` | the disputed point, your position, the other side's claims, the extra evidence | what would change the judgement, how to test it, what disagreement remains |

Left out, `mode` is read from the context: no `context.proposal` is `explore`, a proposal is `review`, a
proposal with `context.counterpoints` is `debate`, and a follow-up keeps its chain's mode. A mode you pass is
checked as given: the server rejects a first-round `explore` that carries a proposal, because `explore` is
anchoring-sensitive — if you want your plan critiqued, that is `review`.

**For a decision heavy enough to be worth two consultations**, ask `explore` first on the facts alone, then
`review` with the proposal, and read what the first raised that the second never did. Measured on this
project: repeat runs of the identical brief did not move the bottom line, while withholding the proposal once
did, and the withheld run was the only one to question what the decision was even about.

## A brief for a decision you will live with

For an interface, a migration, a security or concurrency call, do the organising work first; a vague brief
gets a vague answer.

1. **State the question in one sentence.** `objective` is optional: add it only when what you are after is not
   already in the question.
2. **Write down what a useful answer looks like** (`success_criteria`) — e.g. "a concrete failure scenario with
   numbers, or a clear all-clear with its conditions".
3. **Supply the evidence**: `context.expose_paths` for the files (copied read-only under `./workspace`, and then
   the only part of your repository the consultant has), `context.facts` for the load-bearing facts,
   `context.artifacts` for what is not a file here. For a change you are making,
   `context.expose_diff: { repo, base? }` puts the diff in the brief and copies every file it touches, untracked
   ones included, under `./workspace/repo/` at their repository paths; add `expose_paths` for a caller or the
   spec the change does not touch. The repository's location is not sent.
4. **Include the constraints that make cheap advice useless**: the stack, the traffic, what you cannot change.
5. **Separate imposed constraints from your own assumptions.** Only what you wrote can be doubted.
6. **Write down what you expect, before you send it**: `prediction: { expected, worry }` — the bottom line you
   expect (`proceed` / `do_not_proceed` / `alternative` / `undetermined`) and the one thing you are most worried
   about. It is stored with the consultation and **never sent to the consultant**, and it can only be written
   here, before the consultant runs. Skip it when you have no expectation to commit to.

```
consult_start({ request: {
  target: "codex",
  question: "...",
  objective: "...",                 // optional
  success_criteria: ["..."],
  constraints: ["..."],
  context: { facts: ["..."], proposal: "our plan, and why",
             expose_paths: ["/abs/path/to/the/file.js"],      // or expose_diff: { repo } for a change
             artifacts: [{name, kind, language, excerpt}] },  // test output, a log; not a substitute for the files
  prediction: { expected: "proceed", worry: "..." },   // optional, never sent to the consultant
  caller: "claude-code"
}})
```

`network: "off"` takes web search and browsing away from every consultant in the round; the brief still goes
to each consultant's model. The answer's `boundary` says what each consultant was launched with.

## Several at once

When the user names two peers, `targets: ["codex", "antigravity"]`; 「両方に相談して」 and "ask
both" name two. For *everyone* — 「みんなで相談して」, 「全員に聞いて」, "ask everyone" — `targets: ["all"]`: every
consultant this host can reach, your own CLI on a fresh session included. The server counts them; do not list
names. Your own CLI is a fresh session but not another lineage, and its `quality.caveat` says so; so are two
consultants of one vendor.

Send **one** `targets` call: every consultant receives the byte-identical brief, which is what makes the answers
comparable (on a follow-up to the group, the same new question, with each one's own earlier rounds). Poll the single group with `consult_get({ group_id })` and stop it with
`consult_cancel({ group_id })`. A fan-out takes one slot of the concurrency cap per consultant (nine by default,
shared by every severally session on this machine; the group starts only if every member gets one) and one
consultation's quota per consultant. To ask every member again, follow up the group: `followup_to: "<group_id>"`
with no `target` or `targets` (see Follow-ups).

While you wait, `consult_get` blocks for up to its limit (ten minutes where the client allows it). To work on
something independent in between, pass a shorter `wait_ms` and come back.

`comparison.by_target` holds, per consultant: stance, summary, confidence, evidence basis, finding points (each
with its `id` and severity), `severity_counts`, `decision_changers`, alternatives, unknowns (`u1` …),
next_checks (`c1` …), remaining disagreements, its `caveat`, and how many of its points carry no verdict yet.
Long texts are cut and the column says so (`truncated`); a list that could not hold every item says how many it
left out (`omitted`), so an empty list there is not "none given". `consult_get({ job_id })` returns one
member's whole answer; `consult_get({ group_id, detail: "full" })` returns every member's, and can be too large
to show inline.

Reading them against each other:

1. **Read the `stance` column first.** "This needs sizing, then go" and "this needs sizing, so stop" cite the
   same fact; a shared finding with opposite stances is the divergence that matters most.
2. **List the divergences**, including an unknown or a risk only one of them names.
3. **Check the grounds behind each one** against the code or the docs, not against whichever answer sounds
   more confident.
4. **Read `decision_changers` before spending a follow-up**: a consultant that named the condition under which
   it would change its mind has told you what evidence to go get.
5. **Spend a follow-up only on a divergence that would change your decision**, sent only to the consultant
   whose reading it belongs to.
6. **A stance every consultant shares is not evidence that the plan was checked.** Look for a premise they all
   rely on and none could verify; name it only if you can actually identify one.

Report a divergence you could not settle as a divergence.

### Asking one consultant to answer another

When two consultants are split on a point that decides your call, and checking it yourself did not settle it,
you may show one of them the other's point and ask for a rebuttal: a follow-up (`followup_to` that member's
`job_id`) that quotes the finding word for word with where it came from ("the Antigravity consultant, f2:
…"), and asks what in its grounds is wrong, or what would make it right. Only for points where they are split,
never to pull them into line.

The answer that comes back is **no longer an independent opinion**: the consultant has read the other side. Report
it as "answered after seeing the other's point", apart from the independent answers, and do not count it as a
second vote either way.

## When it fails

`failure.kind` is one of `timeout`, `auth`, `usage_limit`, `rate_limited`, `model_unavailable`,
`invalid_output`, `cli_error`, `spawn_error` or `interrupted` (the server running it exited first). A transient
failure was already re-run inside the same budget (see `retries`). A `timeout` carries the consultant's step trail
in `failure.detail`, which tells you whether to retry with a longer budget or a smaller question, and may carry
`partial_output`: the raw tail of what it had written, not an answer, its points unverified.

## Follow-ups

By default a chain has five rounds: one initial round plus up to four follow-ups
(`followup_to: "<previous job_id>"`); the operator can configure 1–20 (`server.max_rounds`), and
`rounds_remaining` says what is left. `followup_to: "<group_id>"`, with no `target` or `targets`, sends the same new
question to every member of a fan-out, each continuing from its own latest round with its own history; a member
that is still running, never answered or has used its rounds is listed under `skipped` and not asked. A follow-up starts in a fresh working directory with no files: pass
`context.expose_from_parent: true` to copy again, as they are now, the paths the earlier round exposed (a changed
or vanished entry is marked), and leave it off when the follow-up does not need them.

Spend follow-ups only where you and the consultant actually diverge: quote the specific point, give the evidence
that answers it, and ask what would change their view. Write your verdicts with `consult_record` first: the
consultant is shown each earlier point with your verdict, so it answers what your checking found instead of
restating it. A follow-up works across a server restart.

After each follow-up, state in one sentence the cause you still differ on. If it is the same as last round and
the round brought no new evidence and no new condition that would change the judgement, stop and hand the user
the decision material. An early stop is a good outcome. Do not push for agreement; a recorded disagreement is a
legitimate result, and `remaining_disagreements` keeps it.

## Closing out a decision you will live with

Report briefly: what you **checked** and what it showed, what you **adopted** and why, what you **rejected** and
why, what is **still unverified** with the check that would settle it, and what it cost (rounds, wall-clock time,
the usage the result reports).

Write the rest back into the consultation, so it is still there when the decision is questioned a month from now:

```
consult_record({ job_id: "...", entries: [
  { id: "f1", verdict: "confirmed", effect: "capped the retries at 3", note: "reproduced with a 30s outage" },
  { id: "c1", verdict: "unverified", effect: "load test deferred to Thursday's window" }
]})
```

For a fan-out, every member's verdicts go in **one** call, each under its own `job_id` (`f1` of one consultant is
not `f1` of another):

```
consult_record({ records: [
  { job_id: "<codex member>", entries: [{ id: "f1", verdict: "confirmed", effect: "capped the retries at 3" }] },
  { job_id: "<antigravity member>", entries: [{ id: "f2", verdict: "not_applicable", note: "no queue here" }] }
]})
```

Every record is checked first: one wrong `job_id` or id and nothing is written, with each bad one named. A job the
server could not write is listed with `record_not_saved`; record that one again. The job is read back from
`~/.severally/history`, so a verdict can be written days later, from another session, once the check has actually
been run.

The ids are the ones in the answer: findings `f1`, `f2` …, unknowns `u1` …, next_checks `c1` … . The verdict is
**what checking showed, not whether you agreed**: `confirmed` (it holds here), `not_applicable` (true in general,
not for this codebase), `unverifiable` (cannot be settled with what you can reach), `unverified` (you have not
checked it — say why in `effect`). Leaving a point unrecorded and marking it `unverified` are different: the second
is a decision, the first a gap. Recording the same id again replaces it.

If you sent a prediction, add what the answer actually added:

```
consult_record({ job_id: "...", reflection: {
  delta: "expected the retry cap; the autovacuum cost was new to me",
  related_item_ids: ["f2"]
}})
```

There is deliberately **no hit/miss label**; do not invent one. Write what changed in your understanding, or that
nothing did, which is a real result.

Then, when the record belongs in the repository:

```
consult_export({ chain_id: "..." })   // or group_id for a fan-out
```

It comes back as Markdown — the brief as sent, each answer as it came back, your verdicts under their points, the
unchecked ones marked unchecked — for you to write where the decision lives. The tool never writes a file itself.
A routine consultation does not need one.
