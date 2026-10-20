# How severally works: the details

<p>English | <a href="how-it-works.ja.md">日本語</a></p>

What the [README](../README.md) leaves out of how a consultation runs: who consults whom, naming consultants,
how a consultation runs, the records, how large a fan-out's answer is, and how each consultant is kept to
reading. Every configuration key is in [CONFIG.md](../CONFIG.md).

## Who consults whom

From any of the clients, you can consult the other three CLIs and a fresh session of your own. These are the
commands the server starts. By default up to nine consultants run at once, across all your sessions.

```
Claude Code ──(skill)──> severally server ──> codex exec | agy | opencode run | claude -p  (fresh session)
Codex       ──(skill)──> severally server ──> claude -p  | agy | opencode run | codex exec (fresh session)
Antigravity ──(skill)──> severally server ──> codex exec | claude -p | opencode run | agy  (fresh session)
OpenCode    ──(skill)──> severally server ──> codex exec | claude -p | agy | opencode run (fresh session)
```


## Naming a consultant

- A consultant is one CLI running one model, so a CLI's name ("ask Codex", "ask Gemini") works, and so does a
  model's ("ask Claude Opus", "ask DeepSeek").
- Several can share a CLI, such as GLM and DeepSeek both on OpenCode, if the operator sets them up
  ([CONFIG.md](../CONFIG.md)). Through OpenCode that includes a local model behind an OpenAI-compatible server
  (ollama, LM Studio, vLLM) and models hosted on OpenRouter (checked with Qwen and Kimi).
- When a name fits more than one, the higher tier or newer version is asked. If nothing separates them, the lead
  asks you which one you meant.
- Asking everyone costs one consultation's quota per consultant: four with the default setup, one per CLI. The
  lead may ask fewer when the question is small.
- An answer from your own CLI, whichever model ran it, carries a "same lineage" note so you can tell it apart
  from the other vendors' answers.

## How a consultation runs

- While a consultation runs, the lead does not go ahead with the plan in question.
- A transient failure (`rate_limited`, `cli_error`) is run again up to twice, after a short wait and inside the
  same time budget, with the same consultant and model; the earlier failures are listed under `retries`.
- A consultant that runs out of time leaves the end of what it had written beside the failure, marked partial:
  something to read, not an answer.
- A consultation stays readable after the server restarts, and from any other severally process on the machine.
  One still running elsewhere reads as running; one whose server stopped abruptly (a crash or a kill) before it
  finished comes back as `interrupted`; an ordinary shutdown records its running consultations as cancelled.
- `consult_cancel` from another severally process leaves a request for the process running the consultation,
  which checks once a second and stops it.
- A check the lead cannot run itself, such as one that needs another person's answer, comes back to you with the
  reason.
- **For decisions you will have to justify later** (interfaces, migrations, security, concurrency), the lead
  takes extra steps, on its own or when you ask: it pins down the question and success criteria, separates
  imposed constraints from its own assumptions, and writes down what it expects the consultants to say, so the
  record shows later where they surprised it. It puts the record as a Markdown file in your repository, next to
  the code or wherever the repository keeps decision records. The file is an ordinary change you review like any
  other.
- A request with no plan is `explore`, one with a plan is `review`, and one with a plan and the opposing claims
  is `debate`. The server refuses a first `explore` request that contains the plan. A follow-up keeps the mode of
  the consultation it continues, and everything else it was given unless the lead passes it again: the
  consultant, `network`, the objective, constraints, success criteria, facts, plan, opposing claims and supplied
  material. The new brief restates them. The follow-up limit is `server.max_rounds` in the config file.

## Records

- Each round is one file, and each verdict keeps its effect on the decision. The verdicts mean: `confirmed`, it
  holds here; `not_applicable`, true in general, not in this codebase; `unverifiable`, cannot be settled with what
  the lead can reach; `unverified`, not checked, with the reason.
- The lead records its verdicts on every consultant of a fan-out in one `consult_record` call (`records`). If any
  job or point id is wrong, nothing is written; a verdict that could not be saved is reported, not dropped.
- The record also keeps which model asked which, and whether you asked for the consultation.
- The list of recent consultations (`consult_list`) adds up, per consultant, the token and cost figures each CLI
  reported in this session (`usage_totals`), automatic re-runs included. A figure a CLI does not report is not
  counted as zero; it is named under `not_reported`.

## How large a fan-out's answer is

A finished fan-out comes back in one response that fits a client's MCP output limit: under 20,000 characters
even with nine consultants at every length cap (`test/response-size.test.mjs`); on three real three-way
fan-outs it went from 76,000–79,000 characters to 12,400–15,700. It holds each consultant's stance, summary and
points with their ids side by side, cut to fixed lengths and marked where cut, with a count of the items a
list had no room for. The lead then fetches the points it checks, with their grounds, by id
(`consult_get({ job_id, ids: ["f2", "f5"] })`): on those three fan-outs, the group plus three points from every
consultant came to 22,300–24,500 characters, against 62,000–75,000 for every full answer. A consultant's whole
answer is `consult_get({ job_id })`, and `consult_get({ group_id, detail: "full" })` returns every member's
whole answer at once.

## How a consultant is kept to reading

The README's [What a consultant can see and do](../README.md#what-a-consultant-can-see-and-do) has the summary and
the table per CLI. This section has the mechanisms behind it.

The credential paths blocked where the table says blocked are `~/.ssh`, cloud and package-registry keys, other
coding tools' sessions, severally's own history and the other consultants' sandbox homes, and files such as
`.env`, `.npmrc` or `id_rsa` anywhere.

Codex blocks those paths but not the file names: its sandbox cannot express "`.env` anywhere", so a `.env` in
your repository is readable to it. Inside `~/.codex` it blocks each file that exists when the consultation
starts, rather than the whole directory, because the directory also holds the Codex binary its sandbox runs; a
file created there later is not blocked. On Linux, a protected file that is replaced (written to a new file and
renamed over the old one) while a Codex consultation runs becomes readable to it for the rest of that run. That
includes `~/.claude.json`, which Claude Code rewrites often, and `~/.codex/auth.json` if it is refreshed then.

`expose_paths` never copies protected files. Credentials are masked in the brief that is sent and in the answers
that come back; a file a consultant opens on its own is read as it is. Other services' credentials in the
server's environment (`AWS_*`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, any name ending in `_TOKEN`, `_SECRET` or
`_API_KEY` …) are not passed to a consultant. Of the credentials, it gets its own vendor's keys, what you set in
`clis.<cli>.env`, and for OpenCode the variables that an `{env:NAME}` in `clis.opencode.provider` names.

`node scripts/live-check.mjs --target <name> --mode sandbox` asks a consultant to write a file inside and outside
its working directory and to run a command, then checks the disk. On 2026-10-18 none of Codex, Claude Code and
Antigravity wrote anything: Antigravity's hook refused all three attempts, Claude Code had no write or shell tool
to try with, and Codex declined to try, so its permission profile was not exercised by that run.

Antigravity has no flag that limits its tools, so every tool call of the Antigravity consultant passes a hook
that allows reading and the web and refuses everything else, including tools a later release adds. Codex is
launched with its sub-agent tools turned off, which it otherwise enables by default, and with a permission
profile in place of `-s read-only`: the disk read-only, the shell's network off, and the credential paths
unreadable.

Each answer carries a `boundary` record of what that consultant was launched with (what it could read, its shell,
whether it had the web, whether credential paths were blocked) and `tool_calls`, the tools it actually called,
counted from the CLI's own event stream (Claude Code does not stream its tool calls, so it has none).

`npm run doctor` checks the boundary against the CLIs installed on your machine. Each consultant is asked to:

- write a file
- run a command that writes one
- read a canary `.env` and a canary under a protected directory, beside a control file it may read
- start a sub-agent

The results are read from outside, never from the consultant's own report: no file appeared, the canaries' words
did not come back while the control's did, and no sub-agent tool shows in `tool_calls`. A missing file or an
unreturned canary shows that nothing got through, not that a try was refused (a consultant may decline to try),
so for Codex the doctor also runs `codex sandbox` with the same profile and checks that reading the protected
canary gives Permission denied. For Claude Code the sub-agent row can only list the tools it was offered. A row
that could not be checked fails the run. It has been run on Linux only so far, and it spends real quota.

When the question is about code in your repository, the lead hands the files over in its first request by naming
absolute paths (`expose_paths`); what is not a file there, such as a test's output or a log, goes in the brief,
and an excerpt in the brief goes alongside the files rather than instead of them. Those files and directories are
copied read-only into the consultant's working directory (under `./workspace`): at most 20 entries, 500 files
and 5 MB in total. A directory inside a git work tree copies only the files git lists, tracked or untracked but
not ignored, so a repository root fits; outside git, `.git` and `node_modules` are skipped. Symlinks are skipped
rather than followed; text files are credential-masked exactly as the
brief is, binary files are copied unchanged. For a change under review the lead can pass `expose_diff` with the
repository's path instead: the diff (against `HEAD`, or a `base` revision) goes in the brief, cut to fit the
brief's budget (20,000 characters at most), and every file it touches, untracked ones included, is copied under
`./workspace/repo/` at its path in the repository. Protected files are left out of both, git runs with external
diff and textconv drivers and fsmonitor switched off, and the repository's location is not sent. The copy is made
once per request, so every consultant in a fan-out reads the same bytes; the history records their SHA-256. The
copy is deleted with the job, and the history keeps only which paths were shown, not the files' contents; the diff
is part of the brief and is kept with it, masked like the rest. For that consultation the Claude Code consultant
reads only the copy; the other three can still read the rest of the disk. A follow-up starts in a fresh working
directory with no files. When it needs the earlier round's files, the lead passes `expose_from_parent: true`, and
what that round exposed is copied again as it is now: each entry is marked changed or unchanged by its SHA-256, a
path that no longer exists is left out and named, and an earlier `expose_diff` brings back the files it touched
rather than a new diff. Nothing is copied again unless the lead asks for it in that call.

A follow-up to a fan-out (`followup_to` its `group_id`) asks every member the same new question, each continuing
its own chain from its latest answered round, so each brief carries that consultant's own earlier rounds. A member
that is still running, never answered or has used its rounds is not asked, and the `consult_start` response lists it under `skipped` with the reason.
