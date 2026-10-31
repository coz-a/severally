# severally: the rest of the record

`SKILL.md` covers the normal consultation: start, wait, check one point, record it. Read this file for a
decision you will have to justify later, for a follow-up, or for the details of reading several answers at once.

## Available CLI families

| target | Consultant | Reach for it when |
|---|---|---|
| `codex` | Codex CLI | the question is about implementation detail, tricky code, or a decision where a different training lineage helps |
| `antigravity` | Antigravity CLI (Gemini) | you want a third reading, or the question needs current web material |
| `opencode` | OpenCode CLI (whichever models the operator set up: GLM, DeepSeek, ...) | you want another training lineage on the question (GLM by default; the operator may have set up others, such as DeepSeek), or a further reading when the first three stay neck and neck |

## Modes

| Mode | Give it | Get back |
|---|---|---|
| `explore` | a self-contained question; optional objective, constraints and facts; **not your preferred solution** | independent options, alternative framings of the problem, blind spots |
| `review` | your current proposal **and the reasoning behind it** | weaknesses, counterexamples, concrete improvements, the conditions under which it holds |
| `debate` | the disputed point, your position, the other side's claims, the extra evidence | what would change the judgement, how to test it, what disagreement remains |

Left out, `mode` is read from the context: no `context.proposal` is `explore`, a proposal is `review`, a
proposal with `context.counterpoints` is `debate`, and a follow-up keeps its chain's mode. A mode you pass is
checked as given: the server rejects a first-round `explore` that carries a proposal, because `explore` is
anchoring-sensitive — if you want your plan critiqued, that is `review`.

**For a decision heavy enough to be worth two consultations**, ask `explore` first on the facts alone, then
`review` with the proposal, and read what the first raised that the second never did. A consultant that sees
your proposal tends to answer around it; one that does not is more likely to question the framing itself.

A nonempty `question` alone can start `explore`. Separate `context.facts` is optional; do not copy the question
into it or ask the user to repeat its premises. `review` still requires `context.proposal`, and `debate` still
requires both a proposal and `context.counterpoints`. Code questions still need their files or diff.

## A brief for a decision you will live with

For an interface, a migration, a security or concurrency call, select the relevant evidence first.
Inspect imports and actual call sites; include the caller, tests and configuration that determine behavior.
Use `expose_diff` for a change and add only needed `expose_paths`. Ask the consultant to identify missing
premises as unknowns. Zero files, exclusions, deletions and size caps are gaps to resolve or report, not
evidence that code was checked.

Check `exposed_material` in the start response: `totals` gives files and bytes, `entries` describes each
selection, and `skipped` records exclusions and reasons. Compare the implementation with its actual imports
and callers, then add the specific tests and configuration that affect the decision. If material is missing,
add only the relevant paths in a follow-up; if a size cap prevents the start, narrow the requested paths to
the files needed for the question and try again. A self-contained code excerpt does not require exposed files.

1. **State the question in one sentence.** `objective` is optional: add it only when what you are after is not
   already in the question.
2. **Write down what a useful answer looks like** (`success_criteria`) — e.g. "a concrete failure scenario with
   numbers, or a clear all-clear with its conditions".
3. **Supply the evidence**: `context.expose_paths` for the files (copied read-only under `./workspace`; not a read
   boundary -- apart from the protected credential paths, most consultants can still read other files on the disk), `context.facts` for the load-bearing facts,
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
A group wait also returns when a new member finishes. Check its advice while the others continue, then call
again to wait for another completion; an answer already returned does not make later waits return immediately.
`done` still means that all available members have stopped. Keep later disagreements in the final comparison.

`comparison.by_target` holds, per consultant: actual model, stance, recommendation, summary, confidence, evidence basis, finding points (each
with its `id`, severity and grounds), `severity_counts`, `decision_changers`, alternatives, unknowns (`u1` …),
next_checks (`c1` …, with method and expected signal), remaining disagreements, its `caveat`, and how many of its points carry no verdict yet.
Long texts are cut and the column says so (`truncated`); a list that could not hold every item says how many it
left out (`omitted`), so an empty list there is not "none given". Read grounds already shown whole; fetch missing
or shortened deciding points with `consult_get({ job_id, ids: ["f2"] })`. `consult_get({ job_id })` returns one
member's whole answer; `consult_get({ group_id, detail: "full" })` adds only the brief and the question whole.

Reading them against each other:

1. **Read the `stance` and `recommendation` columns first.** The same stance can name different options; missing
   recommendations remain undeclared. "This needs sizing, then go" and "this needs sizing, so stop" cite the
   same fact; a shared finding with opposite stances is the divergence that matters most.
2. **List the divergences**, including an unknown or a risk only one of them names.
3. **Check the grounds behind each one** against the code or the docs, not against whichever answer sounds
   more confident.
4. **Read `decision_changers` before spending a follow-up**: a consultant that named the condition under which
   it would change its mind has told you what evidence to go get.
5. **Spend a follow-up only on a divergence that would change your decision**, sent only to the consultant
   whose reading it belongs to, or to the whole group (`followup_to: "<group_id>"`) when it concerns all of them.
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

To recover one failed member without repeating successful ones:

```
consult_start({ request: { retry_of: "<failed job_id>" } })
```

Pass only `retry_of`: the saved question/context/network are reused and current files are copied again.
A new job and chain link back through `retry_of`; old records remain intact. Changed/deleted files are
shown in the manifest. A saved diff excerpt remains the original one, while its files may now differ;
inspect those changes before using the new answer. Supply a fresh explicit consultation if you need to
change the question, diff or materials. Failed follow-up context remains available, labeled by source job ID.
A completed, cancelled or running job and a group ID are refused. Resolve auth/quota failures before an
explicit retry; do not loop them. If the configured primary CLI/model changed, or the failed attempt ran a
fallback model, `retry_target_mismatch` requires a new explicit consultation. No unrequested model swap.

When the completed job ID is already in the conversation, use it directly. Otherwise,
`consult_list({ question: "cache", target: "codex", limit: 20 })` searches saved
questions by case-insensitive substring and consultant. Add `chain_id` to restrict a known exchange.
Filters apply before the limit. Read candidate questions and ask which one if several fit; never silently
continue a different consultation. `latest_completed_job_id` identifies the most recent answer in the
chain, and `rounds_remaining` includes rounds used by later failures. Deletion/expiry and a changed model can
still block continuation. Do not ask the user to transcribe an ID the list already returns.

## Follow-ups

By default a chain has five rounds: one initial round plus up to four follow-ups
(`followup_to: "<previous job_id>"`); the operator can configure 1–20 (`server.max_rounds`), and
`rounds_remaining` says what is left. `followup_to: "<group_id>"`, with no `target` or `targets`, sends the same new
question to every member of a fan-out, each continuing from its own latest round with its own history; a member
that is still running, never answered or has used its rounds is listed under `skipped` and not asked.

A follow-up needs only `followup_to` and the new `question`:
`consult_start({ request: { followup_to: "<job_id>", question: "..." } })`. The consultant, the mode, `network` and what
the earlier round was given (objective, constraints, success criteria, facts, proposal, counterpoints,
artifacts) carry over, and the brief restates them; a field you pass replaces the earlier one, an empty list
included. A follow-up copies again, as they are now, the paths the earlier round exposed (a changed or vanished
entry is marked; a directory is listed afresh, so files added since go too), together with any `expose_paths`
you add. Pass `context.expose_from_parent: false` when the follow-up does not need them. When the consultant's
name now points at another CLI or model, nothing is copied again unless you pass `true`.

To recheck just one finding with the same code:

```
consult_start({ request: {
  followup_to: "<that consultant's job_id>",
  question: "Recheck f1 against the current code and the verdict I recorded.",
  context: { expose_paths: ["/abs/path/to/new-caller.mjs"] }
} })
```

This adds the newly needed caller to the paths normally recopied from that consultant's own earlier round.
If the consultant's CLI or model changed, check the start result: earlier paths are not copied by default.
Omit `context` if no additional files are needed; do not resend unchanged facts or the previous answer.

Use a member's `job_id` for one consultant in a group. Use the group's `group_id` to ask them all again.
The lead retrieves these IDs from the previous result; the user should not need to transcribe IDs or paths.
The files are copied from their current paths, not restored from an old snapshot. Pass new facts or an
`expose_diff` for changed material. `nothing_to_inherit` means that the parent exposed no files: retry with
explicit `context.expose_paths` or `context.expose_diff`. The same error can mean all old paths have vanished
and no facts or artifacts were supplied;
identify their replacements and expose those, or supply the facts and artifacts needed to discuss their removal;
do not report that missing code was checked.

Spend follow-ups only where you and the consultant actually diverge: quote the specific point, give the evidence
that answers it, and ask what would change their view. Write your verdicts with `consult_record` first: the
consultant is shown each earlier point with your verdict, so it answers what your checking found instead of
restating it. A follow-up works across a server restart; `consult_list` shows an earlier session's
consultations with their `job_id` and `group_id`.

After each follow-up, state in one sentence the cause you still differ on. If it is the same as last round and
the round brought no new evidence and no new condition that would change the judgement, stop and hand the user
the decision material. An early stop is a good outcome. Do not push for agreement; a recorded disagreement is a
legitimate result, and `remaining_disagreements` keeps it.

## Closing out a decision you will live with

Report briefly: what you **checked** and what it showed, what you **adopted** and why, what you **rejected** and
why, what is **still unverified** with the check that would settle it, and what it cost (rounds, wall-clock time,
the usage the result reports).

Save the points you checked in one call, so their evidence is available in the next round and later review:

```
consult_record({ job_id: "...", entries: [
  { id: "f1", verdict: "confirmed", effect: "capped the retries at 3", note: "reproduced with a 30s outage" }
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
**what checking showed, not whether you agreed**: `confirmed` (it holds within the recorded scope), `refuted`
(it did not hold in the recorded check), `not_applicable` (true in general,
not for this codebase), `unverifiable` (cannot be settled with what you can reach), `unverified` (you have not
checked it — say why in `effect`). Leaving a point unrecorded and marking it `unverified` are different: the second
is a decision, the first a gap. Recording the same id again replaces it.

Record the input, environment, result and limit in a short `note`. New notes are forwarded in bounded form;
legacy notes remain local until explicitly recorded again. Keep private or detailed logs outside these notes.
A partial check stays `unverified`: reproducing a cache-key collision does not establish where authentication
runs or prove authentication bypass. Example: `note: "Node.js synthetic cache fixture: collision reproduced;
authentication order was not supplied or checked"`, `effect: "fix tenant isolation; leave bypass unverified"`.
`refuted` is not a substitute for `not_applicable` or `unverifiable`.

If you sent a prediction, add what the answer actually added:

```
consult_record({ job_id: "...", reflection: {
  delta: "expected the retry cap; the autovacuum cost was new to me",
  related_item_ids: ["f2"]
}})
```

There is deliberately **no hit/miss label**; do not invent one. Write what changed in your understanding, or that
nothing did, which is a real result.

Only when a record is requested for the repository or another explicit destination, export it:

```
consult_export({ chain_id: "..." })   // or group_id for a fan-out
```

It starts with the verified points, their effects and evidence, links to full points, and the unverified count.
This is a mechanical listing: a confirmed point is not automatically adopted.
A retry export names its source failure and retained earlier context in a separate appendix, with source
job/chain IDs. Expired source records are named; later verdict updates may appear and prior context may have
been shortened when sent. The full Markdown keeps
the brief as sent, each answer as it came back, your verdicts under their points, the
unchecked ones marked unchecked — for you to write where the decision lives. The tool never writes a file itself.
A routine consultation does not need one.
