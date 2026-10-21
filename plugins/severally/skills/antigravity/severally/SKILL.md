---
name: severally
description: Use when a decision deserves a second, independent mind - an architectural or hard-to-reverse choice, two options that look genuinely close, or an investigation that has stalled - to get an independent opinion, review or structured debate from Codex or Claude Code or OpenCode through the severally MCP server. Also use when the user asks for it directly, in any wording - the phrases here are examples, not an exact list, and a request to ask everyone at once counts however it is phrased ("ask GPT", "get GPT to review this", "gptと相談して", "gptにレビューしてもらって", "ask Claude", "get Claude to review this", "Claudeに聞いて", "Claudeにレビューしてもらって", "ask GLM", "get GLM to review this", "GLMに聞いて", "GLMにレビューしてもらって", "みんなで相談して", "みんなに聞いて", "全員に聞いて", "両方に相談して", "ask everyone", "ask both", "second opinion", "セカンドオピニオン").
---

# Consulting a peer agent

You have three peers, each reached through the `severally` MCP server as a fresh child session that can read files
and search the web, but not edit them, load MCP tools, see your session or consult anyone else. The server sends only
the brief and the files you explicitly expose; the CLI may also read other files as described in `reference.md`.

One caveat on that list: a consultant can read local files. Its writes are blocked,
its network reaches only web search and browsing (none with `network: "off"`), credential and history
paths are refused where its CLI allows, and by default it starts in an empty working directory without being
told where your repository is, so it answers from the brief and from the files you hand it:
`context.expose_paths` (absolute paths) or `context.expose_diff` (a change in progress), which are
copied read-only into its working directory. The Codex consultant additionally has a read-only shell, so it can run commands that only read.

## A normal consultation is three calls

1. **`consult_start`**. A self-contained question is enough for a general consultation:

   ```
   consult_start({ request: {
     targets: ["all"],
     question: "Our read-only public API gets 100 requests per minute; updates may appear 60 seconds late. Is a 30-second cache reasonable?",
     caller: "antigravity"
   }})
   ```

   For a code question, also attach its files in `context.expose_paths` or its diff in `context.expose_diff`
   (see **Write the first request**).

2. **`consult_get({ group_id })`** (`consult_get({ job_id })` for one consultant). It waits for the answer by itself,
   up to a limit the server sets (45 seconds, or ten minutes where the client allows it); call it again while
   `status` is `running`. To work on something independent meanwhile, ask for a shorter wait (`reference.md`).
3. **Check one point, report, and record it once** (see **Before you hand the decision back**).

That is the whole routine. The rest — follow-ups, a prediction and reflection, the export, reading a fan-out
in detail — is in `reference.md`, in the same directory as this file. Read it for a decision you will have to
justify later. Short follow-ups are below; the reference has the limits and recovery steps.

## Follow-ups

For "recheck just this finding", use the previous answer's `job_id` without asking the user to copy it.
For a text-only continuation:

```
consult_start({ request: { followup_to: "<job_id>", question: "What would change your view on f1?" } })
```

To recheck the same code, add `context: { expose_from_parent: true }`. Files are not inherited automatically;
this copies the exposed paths' **current contents**, with changed or deleted entries noted in the manifest.
Supply the latest facts or diff when they changed. To ask one member of a group, use that member's `job_id`;
use the `group_id` only to ask every member again. See `reference.md` for missing-file recovery.

## Pick the consultant

| target | Consultant | Reach for it when |
|---|---|---|
| `codex` | Codex CLI | the question is about implementation detail, tricky code, or a decision where a different training lineage helps |
| `claude-code` | Claude Code CLI | you want a careful reading of a design or a long brief, or the decision hinges on trade-offs rather than a single fact |
| `opencode` | OpenCode CLI (whichever models the operator set up: GLM, DeepSeek, ...) | you want another training lineage on the question (GLM by default; the operator may have set up others, such as DeepSeek), or a further reading when the first three stay neck and neck |

**When they just ask for a second opinion, with no target named:** ask everyone — `targets: ["all"]` —
not just one. That is every consultant the operator set up, your own CLI on a fresh session included when it
is one of them, whatever model you are running as: a fresh session has none of this session's history, sunk
cost or drift toward your framing. The server marks that answer as same lineage. A default request therefore
costs one consultation's quota per consultant. Narrow to `target` (singular) only when the user names a
specific peer, or when the decision clearly does not warrant that much. This is the one rule for how many to
ask.

The operator decides which consultants exist; `consult_start`'s description lists the ones this machine can
actually reach. When the user names one, pass **the word the user used** as `target`
(「Claude Opusと相談して」 is `target: "claude opus"`). `target_ambiguous`: ask the user which one they meant.
`target_unavailable`: take the available list as final and tell the user.

**Do not pick a model yourself.** When the user named no one, ask everyone; overriding the operator's
consultants on your own judgement — including after a `usage_limit` failure — substitutes a different mind
for the one the user asked for. The operator may have set a fallback model for that case; a caveat reading
"answered by X: Y's quota was used up" means it answered, and your report names X as the one who answered.

Consult your own CLI (`target: "antigravity"`) freely, alone or alongside the peers, and the same goes
for a **different model of your own lineage** when the user wants one (an Opus lead asking Fable). Either is a
fresh mind but not another lineage; when the risk is your model's blind spot, add the other peers. Pass
`caller: "antigravity"` and, when you know it, `caller_model` (the model you run on), so a same-vendor
answer can say which model answered.

## When this is worth it

When a wrong answer is expensive or hard to undo (an interface, a migration, a security or concurrency design),
two options still look close, an investigation has stalled after two attempts, or the user asked. Not for
anything you would be comfortable defending on your own.

**Before you ask the user to approve a change that is hard to reverse** and nobody else has reviewed it,
consult first — everyone, as above — and check the point that decides it. Do not ask whether to consult. Then go
to the user only with what is theirs to decide: the change itself, and any finding your checks could not settle,
each with what you checked, what you recommend and what is still unverified. The one exception is material that
must not reach another vendor's model (customer data, code under an agreement, anything the user would not paste
into a web form): ask before you send it, or leave it out of the brief.

Pass `initiator: "user"` when the user asked for the consultation; leave it out when you started it yourself.

## Write the first request

- **Ask one decidable question.** What runs out the clock is scope, not brief length: when the budget runs out
  the session is killed and you get nothing. Split "research everything about X" or three questions at once,
  and ask the one whose answer changes what you do next.
- **Hand over the code.** The consultant is not told where your repository is. Name the files by absolute path
  in `context.expose_paths` (a repository root works; never your home directory or one holding keys), or pass
  `context.expose_diff: { repo: "<absolute path>" }` for a change you are making. When `consult_start` answers
  `files_exposed: 0` and the question is about code, `consult_cancel` and start again with `expose_paths`.
- **Keep the premises in the question**, or use `context.facts` when separate facts help. A question containing
  its own premises needs no separate context; do not ask the user to repeat them as `context.facts`. Put test
  output or a log in `context.artifacts`.
- **Leave `mode` out**; it follows from the context. To gather opinions without showing your own, leave
  `context.proposal` empty: a reviewed plan is answered around the plan.
- A constraint is read as fixed and will not be challenged; if it is your own call, put it under `facts` with
  its reason. For material that must not leave the machine through a URL, pass `network: "off"`.

## While it runs

`consult_get` reports `progress`, the consultant's own step trail. If it grinds on without converging,
`consult_cancel({ job_id })` (or `{ group_id }`) and ask something narrower rather than waiting out the budget.

## Reading the answer

Check `status` first. **`failed`** means no advice was obtained (`failure.kind` says why: `timeout`,
`usage_limit`, …): say so plainly and decide on your own, never as "the consultant had no concerns".
**`completed`** with `quality.evidence_basis` `thin` or a `quality.caveat` about missing grounds is weak advice;
weigh it accordingly.

For several consultants, every one received the **identical brief**, and `comparison.by_target` lays their
answers side by side: `stance`, summary, finding points, unknowns and next_checks, each point with its `id`.

- **Read the `stance` column first.** Consultants that share a finding can land on opposite bottom lines, and
  that is the divergence that matters most.
- **Matching summaries are not agreement.** The server does not judge agreement; "both agreed" is a claim you
  have to earn from the grounds.
- **Fetch the grounds before you lean on a point:** `consult_get({ job_id, ids: ["f2", "u1"] })` on that member
  returns just those points, whole. Do that for every point you adopt, that decides your call, or that every
  consultant assumes.
- A same-vendor answer's caveat lowers the weight of its *agreement* with you; it is not a reason to discard its
  findings.

A confident claim about your codebase is a hypothesis until you check it against the code.

## Before you hand the decision back

1. **Pick the one check that would change the decision**, from `decision_changers` and `next_checks`, and say
   why that one.
2. **Run it here, read-only**: a test, a grep, a read of the docs. If it needs another person or a production
   system, do not run it; say so.
3. **Come back with three things**: what you checked and what it showed, the decision you now recommend, and
   what is still unverified, point by point.

Then write the check's verdict back, in one call:

```
consult_record({ job_id: "...", entries: [
  { id: "c1", verdict: "confirmed", effect: "the retry cap holds; recommending we proceed", note: "ran the 30 s outage test" }
]})
```

The verdict is what checking showed: `confirmed`, `not_applicable`, `unverifiable`, or `unverified` (not yet
checked). A point you only read is unverified, however plausible it looks.

The decision, the verification and the change stay yours.
