---
name: severally
description: Use when a decision deserves a second, independent mind - an architectural or hard-to-reverse choice, two options that look genuinely close, or an investigation that has stalled - to get an independent opinion, review or structured debate from Codex or Antigravity or OpenCode through the severally MCP server. Also use when the user asks for it directly, in any wording - the phrases here are examples, not an exact list ("ask GPT", "get GPT to review this", "gptと相談して", "gptにレビューしてもらって", "ask Gemini", "get Gemini to review this", "Geminiと相談して", "Geminiにレビューしてもらって", "ask GLM", "get GLM to review this", "GLMに聞いて", "GLMにレビューしてもらって", "みんなで相談して", "みんなに聞いて", "全員に聞いて", "両方に相談して", "ask everyone", "ask both", "second opinion", "セカンドオピニオン").
allowed-tools: mcp__plugin_severally_severally__consult_get mcp__severally__consult_get mcp__plugin_severally_severally__consult_list mcp__severally__consult_list mcp__plugin_severally_severally__consult_record mcp__severally__consult_record mcp__plugin_severally_severally__consult_export mcp__severally__consult_export mcp__plugin_severally_severally__consult_cancel mcp__severally__consult_cancel
---

# Consulting a peer agent

Each consultant gets a fresh CLI session, the brief and exposed files, without your conversation history.

A consultant can read local files. Its writes are blocked, its network reaches only web search and
browsing (none with `network: "off"`), and credential and history paths are refused where its CLI allows.
It starts in an empty working directory and is not told where your repository is, so it answers from the
brief and the files you hand it. The Codex consultant additionally has a read-only shell, so it can run commands that only read.

## A normal consultation is three calls

1. **Start** with one decidable question. For a code change, read its imports and callers, then select the
   diff, relevant caller, tests and configuration. Use `expose_diff` for the change and `expose_paths` for
   needed files outside it; do not send a whole repository by default. Example:

   ```
   consult_start({ request: {
     targets: ["all"],
     question: "Does the retry cap hold when the caller cancels during an outage? Identify missing premises as unknowns.",
     context: {
       expose_diff: { repo: "/abs/path/to/repo" },
       expose_paths: ["/abs/path/to/repo/src/caller.mjs", "/abs/path/to/repo/test/client.test.mjs"]
     },
     caller: "claude-code"
   }})
   ```

   A self-contained question needs no files. Put extra premises in `context.facts`, test output or logs in
   `context.artifacts`. Leave `mode` out: facts imply explore, a `proposal` implies review, opposing
   `counterpoints` imply debate. Ask for one decision, not a broad investigation that may exhaust the timeout.
   Inspect `files_exposed` and the manifest: zero files for a code question, skipped or deleted files, or a
   size-limit error need attention. Select replacements or a smaller set; missing material stays unknown.

2. **Collect** with `consult_get({ group_id })` (one consultant: `{ job_id }`). It waits by default; repeat
   while running. `progress` shows activity; `consult_cancel({ group_id })` or `{ job_id }` stops the work.
   `failed` means no advice, never "no concerns". Use successful answers even when another member fails.

3. **Check, record once, report.** Follow **Before you hand the decision back** below. No reference fetch,
   export, prediction or reflection is required for a routine consultation.

Detailed recovery, limits, prediction and reflection are in `reference.md`, in the same directory as this file.
Read only when needed.

## Pick the consultant

For a second opinion with nobody named, use `targets: ["all"]`: every available consultant, your own CLI on a
fresh session included. A fan-out costs one consultation per consultant and takes one seat each under the
concurrency cap. Use `target` when the user names one or the decision warrants a narrower consultation.
For two independent readings: `targets: ["codex", "antigravity"]`.

Pass the user's wording (`target: "claude opus"`). The tool lists who it can actually reach;
`target_ambiguous` needs the user's choice, `target_unavailable` means use the available list and explain.
**Do not pick a model yourself**, including after `usage_limit`. The operator owns model settings and fallback;
report the actual answering model. `target: "claude-code"` is valid, as is a different model of your own lineage
when requested. Pass `caller: "claude-code"` and `caller_model` when known. A fresh same-lineage answer is
not another lineage; that caveat is not a reason to discard findings unread.
Pass `initiator: "user"` when the user asked; leave it out when you started it yourself.

## Reading the answer

Every group member received the identical brief. In `comparison.by_target`, read each actual model and
`stance` and `recommendation` first: matching stances can recommend different actions, and consultants can share
a finding and reach opposite conclusions. **Matching summaries are not agreement.** Compare `decision_changers`
and `unknowns` as conditions; keep different grounds and assumptions separate. Do not count votes. A null
recommendation was not declared; do not invent one from its summary. A failed member gave no advice.

Read the grounds already shown. A `quality.caveat` or thin evidence limits what the answer establishes.
Only when a deciding point's grounds or details are missing or shortened, fetch
`consult_get({ job_id, ids: ["f2", "u1"] })`; `{ job_id }` gets one member's full answer. Do not mark a point
confirmed from a clipped summary or treat a filename in a tool input as proof of understanding.
`quality.redaction` marks replacements in files, brief and result; null means unknown. Identical markers do not
establish equality of original values. Compare field presence/removal, types and structure, and reproduce a
safe local example. Never recover secrets or treat two masked values as equal.
For a runnable synthetic example, keep field and sample in separate variables, construct it with
`Object.fromEntries([[field, sample]])` and inspect boolean predicates; literal credential assignments can
become invalid after masking. Do not print original field values.

## Before you hand the decision back

Run the **one check that would change the decision**, using `decision_changers` and `next_checks`: a test,
source read or documentation check. State why it matters. If it needs another person or production access,
name what is still unverified. Save only what you checked in one call, before reporting:

```
consult_record({ job_id: "...", entries: [
  { id: "c1", verdict: "confirmed", effect: "hold release until retries are capped", note: "outage test reproduced amplification" }
]})
```

For a fan-out use one `consult_record({ records: [{ job_id: "...", entries: [...] }, ...] })` call.
`verdict` is verification: `confirmed`, `refuted`, `not_applicable`, `unverifiable` or `unverified`. `effect` is the decision's
change; `note` names checked inputs/environment, evidence and limits. Refuted means the claim did not hold in
that check; partial confirmation stays unverified with its scope in note. New notes go to follow-ups in bounded
form; legacy notes remain local until recorded again. Keep detailed or private logs out of shareable notes.
Confirmed does not mean adopted. Reading alone stays unverified; remaining
points need no entry. Report the deciding point, consultant and actual model, job/point ID, grounds, your
check, adoption or rejection and remaining unknowns. Preserve opposite stances even with a shared finding.

## Follow-ups and approval

For "recheck this", retrieve the earlier job ID yourself and use
`consult_start({ request: { followup_to: "<job_id>", question: "Recheck f1 against the current code." } })`.
For a failed member use `consult_start({ request: { retry_of: "<failed job_id>" } })` with no other fields,
after fixing auth/quota causes; keep successful answers. The retry is a new chain linked to the failure.
Find saved consultations with `consult_list({ question: "cache", target: "codex" })`; use the
matching chain's `latest_completed_job_id` and check `rounds_remaining`. Confirm ambiguous candidates.

A group's `group_id` asks every eligible member again; use a member's `job_id` for one. Files are recopied in
their current state, changes and deletions noted; add needed `expose_paths`. See the reference for recovery.

Use this for expensive decisions, close options or a stalled investigation, not routine edits.
**Before you ask the user to approve** a hard-to-reverse change nobody else reviewed, consult first and check
the deciding claim. Do not ask whether to consult. Material that must not reach another vendor's model needs
permission before sending; omit it if permission is absent. `network: "off"` disables web access, but the brief
and files read still reach the consultant's model. The decision and verification remain yours.
