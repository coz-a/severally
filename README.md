# severally

*Independent opinions, returned severally. The verdict is yours.*

An MCP server and Skill for the moment a coding agent asks you "can I go ahead with this plan?". The agent asks
another CLI (Codex, Claude Code, Antigravity running Gemini, or OpenCode running GLM) for its opinion, checks
the findings that come back in its own repository, and only then asks you for a decision again.

The name comes from the legal phrase *jointly and severally* — each party bound on its own. Ask several
consultants and their answers are not merged: each comes back separately, and the reader decides which to take.

## Example: before publishing a tool

I had written a small tool that rewrites AI CLI conversation histories when a project folder moves. Before
putting it on GitHub and PyPI, I asked three consultants at once "what must be fixed before this is published?".
About two minutes later their answers came back side by side (excerpt):

```
codex        do_not_proceed  no handling for a failure partway through moving the folder and updating several config files
antigravity  do_not_proceed  no LICENSE; --force means both "ignore the running-session check" and "merge folders"
claude-code  proceed         fine to publish, once 5 items such as adding a LICENSE and removing the author's local paths are done
```

The blockers the three raised overlap heavily, yet the bottom lines split. The difference is "fix it, then
publish" versus "publish once it is fixed". Merge the answers into one and that difference disappears.

The agent that asked (the *lead*) does not stop at reading the findings. It checks them in its own repository.

```
codex finding        needs handling for a failure partway through
  checked            if the destination is inside the source, it crashes with a traceback.
                     it also turned up a bug: after rolling back partway, the tool still exits 0
  decision           added a fix to the pre-publication work: count failures, exit non-zero, tell the user to re-run

antigravity finding  reads large history files entirely into memory, so it runs out of memory
  checked            the largest file on this machine is 43.8 MB. the reading will be fixed, but the severity was lowered
```

What comes back to you is not a vote of "1 for, 2 against". It is what was checked, the recommendation, and a
list of what has not been checked yet. The checked results stay next to the findings and can be exported as
Markdown into your repository.

## Compared with pasting into another terminal

You can get something similar by pasting a brief into another terminal. severally adds three things:

- **Only the brief goes across.** Each consultant starts in a fresh child session and never sees your
  conversation history. In `explore` mode, which asks without showing your plan, the field for the plan
  (`proposal`) cannot be used
- **Every answer has the same shape.** Bottom line, findings with grounds, missing information, conditions that
  would change the judgement, and how to check. If no answer arrives, the reason (rate limit, auth failure,
  timeout). Ask several and nothing is summarised
- **Checked results can be written back next to each finding.** For each finding, record "confirmed / not
  applicable / unverifiable / unverified" and its effect on the decision, then export it as Markdown

Whichever of Codex, Claude Code, Antigravity, or OpenCode you use, you can ask the other three.

## How it works

Every consultation starts a dedicated child session; it never attaches to an existing one. The consultant
receives only the brief you wrote, never your conversation history. One request can send the identical brief to
up to four consultants and collect the answers under one `group_id`. What consultants may and may not do is
listed under "Before you use it".

```
Claude Code ──(skill: severally)──> mcp: severally ──> codex exec | agy | opencode run
Codex       ──(skill: severally)──> mcp: severally ──> claude -p  | agy | opencode run
Antigravity ──(skill: severally)──> mcp: severally ──> codex exec | claude -p | opencode run
OpenCode    ──(skill: severally)──> mcp: severally ──> codex exec | claude -p | agy
```

Claude Code and Codex get it as a plugin; Antigravity and OpenCode are registered directly by the installer
(Antigravity has no verified plugin path, OpenCode has no plugin mechanism). Neither needs a public
marketplace.

## Install

Requires Node.js 20.10 or newer. Windows runs natively from PowerShell or Command Prompt;
WSL is not required. Install and authenticate the consultant CLIs you want to use first.

```bash
npm install                 # fetch dependencies
npm test                    # offline checks (no real API calls)
npm run build               # regenerate dist/ inside the plugin (committed, so usually not needed)
node scripts/install.mjs    # --dry-run prints the plan without changing anything
```

Verify:

```bash
claude plugin details severally      # Skills (1) / MCP servers (1)
codex  plugin list                   # severally@severally-local  installed, enabled
agy    mcp list                      # severally  stdio  enabled
opencode mcp list                    # severally  connected
```

**Restart the clients** (a running session does not reload plugins).
After updating the plugin, run `npm run build && node scripts/install.mjs` again.

### Windows (PowerShell)

```powershell
npm.cmd install
npm.cmd test
npm.cmd run build
node scripts/install.mjs
```

On Windows the installer defaults to **manual mode** for all four clients. It copies the
standalone server (including its dependencies) to `~/.severally/runtime/severally-mcp.mjs`,
registers that file with the absolute path to `node.exe`, and copies each client's Skill.
After successful registration, the source checkout can be moved or deleted. Node.js must remain
installed. Global npm installation is unnecessary; `--skip-global` is still accepted but is optional
on Windows. Add `--dry-run` to inspect the changes without writing anything.

**Upgrading an earlier checkout-based installation:** run `node scripts/install.mjs --force`
to switch the existing MCP registrations to the dedicated runtime. Without `--force`, existing
registrations are preserved and may still point to the checkout. Updates replace the runtime
after checking the new bundle's syntax and backing up the previous file. To update later, obtain
a new checkout, run `npm.cmd install`, `npm.cmd run build`, and the installer again, then restart
the clients. The temporary checkout is no longer needed after registration succeeds.

Verify with `claude mcp get severally`, `codex mcp get severally`, `agy mcp list`, and `opencode mcp list`,
then restart the clients. Tool names in this mode are `mcp__severally__*`.

CLI detection supports `.exe`, `.cmd`, and `.bat` through `PATH`/`PATHEXT`, including paths with
spaces. For a custom executable path in `config.json`, use forward slashes
(`"bin": "C:/Tools/claude.exe"`) or escaped backslashes (`"bin": "C:\\Tools\\claude.exe"`).
The test suite uses local stand-in CLIs; authentication and live consultations still depend on
the installed client versions and accounts.

### Linux/macOS: installation independent of the checkout

After a successful installation, the source checkout can be moved or deleted on Linux and macOS too:

- Claude Code receives a copy of the bundled plugin in `~/.claude/skills/severally/`.
- The standalone server lives in `~/.severally/runtime/severally-mcp.mjs`.
- Codex launches the global `severally-mcp` command, installed from that persistent runtime.
  Its marketplace and plugin files are copied into `~/.severally/marketplace/`.
- Antigravity and OpenCode (and all clients in `--manual` mode) launch Node.js with the copied runtime
  directly; OpenCode is registered into `~/.config/opencode/opencode.json` and its Skill is copied to
  `~/.config/opencode/skills/severally/`.

To migrate an existing installation, run:

```bash
npm install
npm run build
node scripts/install.mjs --force
```

This refreshes the Codex marketplace location and switches existing direct MCP registrations to the
copied runtime. Restart the clients after registration succeeds; the checkout is then disposable.
Node.js and the installed runtime must remain. For updates, obtain a fresh checkout and run the same
commands. Previous runtime and marketplace files are backed up under `~/.severally/backups/`.

Plugin mode requires npm's global executable directory on `PATH`. `--skip-global` is accepted only
when `severally-mcp` already resolves to the copied runtime; a command linked to an old checkout is
rejected. In `--manual` mode no global install is needed and `--skip-global` is optional.

### Two install modes

| | Plugin mode (default on macOS/Linux) | Manual mode (`--manual`, default on Windows) |
|---|---|---|
| Claude Code | places the plugin in `~/.claude/skills/severally/` (`severally@skills-dir`) | `claude mcp add --scope user` + copy the Skill on its own |
| Codex | `codex plugin add` from the copied marketplace | `codex mcp add` + copy the Skill on its own |
| Antigravity | `agy mcp add` + copy the Skill on its own (there is no plugin route, so both modes are the same) | same |
| OpenCode | `opencode mcp add severally -- …` + copy the Skill on its own (no plugin mechanism, so both modes are the same) | same |
| MCP tool names | `mcp__plugin_severally_severally__*` | `mcp__severally__*` |

The installer does not break existing settings. It changes client settings only through each CLI's own commands
(`plugin add` / `mcp add`). Before it does anything, it backs up `~/.claude.json`, `~/.codex/config.toml` and any
existing Skill directory to `~/.severally/backups/<timestamp>/`, naming each backup after its original path.
Switching modes backs up and then removes the duplicate registration left by the other mode.

No public marketplace listing is needed. Claude Code works without a marketplace, and the Codex marketplace file
`.agents/plugins/marketplace.json` is copied from this repository into the managed marketplace directory.

## Usage

The Skill starts on requests such as "ask Codex", "have Claude review this" or "I want a second opinion", or in
these situations:

- important design decisions and hard-to-reverse choices (architecture, data migration, concurrency, security,
  pre-publication checks)
- options that stay neck and neck however long you think about them
- two or more failed attempts at the same bug with no new information

For "ask everyone" or "consult all of them", the same brief goes out at once to the other three CLIs and to a fresh
session of your own CLI. Answers from your own CLI carry a "same lineage" note.

When the agent asks you to approve a hard-to-reverse change, it offers "consult first?" as one of the choices.
You decide whether to start.

**Not for small fixes.** One consultation costs a few minutes and real quota.

**A routine consultation is small.** One consultant. The brief is one paragraph of plan, a few lines of facts it
rests on, and one relevant code excerpt. The Skill checks the one finding that would change the decision, reports
what it checked, what it did not adopt and what is still unverified, and saves the checked result next to the
finding. Starting a consultation returns immediately, so the agent keeps working while it waits.

**For decisions you will have to justify later** (interfaces, migrations, security, concurrency), the Skill adds
steps: it pins down the question and success criteria, separates imposed constraints from its own assumptions,
writes down a prediction before consulting, and exports the record as Markdown into the repository.

The Skill tells the lead how to write the brief, which mode to pick (`explore` / `review` / `debate`), and how to
read the results.

## Configuration

**No configuration needed by default.** At startup the server checks whether `codex` / `claude` / `agy` /
`opencode` are on PATH and drops the ones that are missing. To disable a consultant, change a model, or point
at a specific executable, put a single `~/.severally/config.json` in place. A template can be generated for
your machine:

```bash
npm run init-config            # writes ~/.severally/config.json (never overwrites an existing one)
```

The available keys are in [config.example.json](config.example.json). Precedence is environment variables >
config file > auto-detection > defaults. The config is read once at server startup, so restart the client after
changing it.

## Before you use it

### Consultation round limit

A consultation chain defaults to **5 total rounds** (one initial consultation and up to four follow-ups).
Set `SEVERALLY_MAX_ROUNDS` in the MCP server's environment to change the limit to **1–20 total rounds**;
values above 20 are capped at 20. For example, `SEVERALLY_MAX_ROUNDS=20` allows the initial consultation
plus 19 follow-ups. Restart the client/server after changing this setting. This is an environment setting,
not a key in `config.json`. The server reports the active budget in `rounds_remaining`.

**What never reaches a consultant**: your conversation history. **What no consultant can do**:

- write
- use the network (web search and browsing are the only exception)
- use MCP
- consult anyone else

**Reading is not blocked.** Per child session:

| Consultant | Reads the disk | Shell | Write / execute |
|---|---|---|---|
| Codex | yes | read-only | no |
| Claude Code | yes (`Read` / `Glob` / `Grep`) | none | no |
| Antigravity | yes (`read_file`) | none | no |
| OpenCode | yes (`read` / `glob` / `grep`) | none | no |

Every consultant starts in an empty working directory, and the server does not tell it where your repository
is. Paste whatever it should see into the brief — or, when a consultant needs to explore rather than read what
you picked out, name absolute paths in `context.expose_paths`. Those files and directories are copied read-only
into the consultant's working directory (under `./workspace`) and are then the only part of your repository it
has. At most 20 entries, 500 files and 5 MB in total; symlinks are skipped rather than followed; text files are
credential-masked exactly as the brief is, binary files are copied unchanged. The copy is deleted with the job,
and the history keeps only which paths were shown, not their contents. The Claude Code consultant's whole-disk
read scope is dropped for a consultation that uses it.

- A consultant that failed (`usage_limit` / `auth` / `timeout` …) and one that answered on thin grounds come back
  as different things. A failure is not "no problems found"
- History is kept in `~/.severally/history/`. Each round is one file holding the brief that was sent, the
  consultant's answer, and the verdicts the lead wrote per finding (with `consult_record`). `consult_export` turns
  it into Markdown for the repository. Verdicts can be added later, from another session
- Credentials are masked in the brief that is sent and in the results that come back
- You can also consult a different model of your own CLI (from Opus to Fable, `target: "claude:fable"`). The
  answer carries a "same lineage" note. Declare your own model with `caller_model` and the record keeps who asked
  whom
- The record also keeps whether you asked for the consultation or accepted the agent's offer (self-declared).
  Offers you declined are written one per line to `~/.severally/history/offers.jsonl`. Neither restricts anything
- Consultations about code decisions return mostly checks the lead can run itself. Consultations about project
  policy return checks that depend on other people, and those come back to you unrun

## Uninstall

Windows (the default manual installation):

```powershell
claude mcp remove severally -s user
codex mcp remove severally
agy mcp remove severally
# opencode has no `mcp remove`; delete the "severally" entry from
# the "mcp" object in $HOME/.config/opencode/opencode.json
Remove-Item -LiteralPath "$HOME/.claude/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.codex/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.gemini/config/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.config/opencode/skills/severally" -Recurse -Force
Remove-Item -LiteralPath "$HOME/.severally/runtime" -Recurse -Force
# Only if you previously installed the global command:
npm.cmd uninstall -g severally-mcp
```

If `CODEX_HOME` is set, use that directory instead of `$HOME/.codex` for the Codex Skill.

macOS/Linux:

Plugin mode:

```bash
rm -rf ~/.claude/skills/severally                       # Claude Code
codex plugin remove severally --marketplace severally-local
codex plugin marketplace remove severally-local
agy   mcp remove severally                              # Antigravity (registered directly in both modes)
rm -rf ~/.gemini/config/skills/severally
# OpenCode (registered directly in both modes; opencode has no `mcp remove`,
# so delete the "severally" entry from the "mcp" object by hand):
#   edit ~/.config/opencode/opencode.json(c)
rm -rf ~/.config/opencode/skills/severally
npm uninstall -g severally-mcp
rm -rf ~/.severally/runtime ~/.severally/marketplace
```

Manual mode:

```bash
claude mcp remove severally -s user
codex  mcp remove severally
agy    mcp remove severally
# opencode: delete the "severally" entry from the "mcp" object in
# ~/.config/opencode/opencode.json(c) by hand
rm -rf ~/.claude/skills/severally ~/.codex/skills/severally ~/.gemini/config/skills/severally \
       ~/.config/opencode/skills/severally
# Only if a global command was previously installed:
npm uninstall -g severally-mcp
rm -rf ~/.severally/runtime ~/.severally/marketplace
```

Either way, history and backups stay in `~/.severally/` (delete it if you no longer need them).
