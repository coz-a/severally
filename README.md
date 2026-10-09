<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/images/logo-dark.png">
    <img src="assets/images/logo.png" alt="severally" width="480">
  </picture>
  <br>
  <em>Independent opinions, returned severally. The verdict is yours.</em>
</p>

<br>

An MCP server and Skill for the moment a coding agent asks you "can I go ahead with this plan?". The agent asks
another CLI (Codex, Claude Code, Antigravity running Gemini, or OpenCode running GLM) for its opinion, checks
the findings that come back in its own repository, and only then asks you for a decision again.

All you do is say "ask Codex" or "get a second opinion". The agent writes the question, sends it, reads the
answers and runs the checks. The decision stays with you.

The name comes from the legal phrase *jointly and severally* — each party bound on its own. Ask several
consultants and their answers are not merged: each comes back separately, and the reader decides which to take.

## Example: before adding a cache

A small shop API has a slow product page: `GET /products/:id` takes about 800 ms. The agent, running in Claude
Code, proposes the obvious fix, "keep each response in an in-memory Map for 5 minutes", and is about to ask "can I
go ahead?". First it shows the plan to three consultants: Codex, Antigravity, and a fresh Claude Code session
(a new session of the agent's own CLI, with none of its conversation). Their answers come back side by side
(excerpt from a real run against a sample API):

```
codex        do_not_proceed  the price depends on who is asking, so the first visitor's price is served to
                             everyone; the SQL join already inflates stock
claude-code  do_not_proceed  same price leak and join bug; also 4 worker processes keep separate caches, so
                             stock stays stale after orders
antigravity  alternative     same price leak, but fix the SQL first: the join inflates stock and is likely
                             why the page is slow
```

Each answer opens with a bottom line: `proceed`, `do_not_proceed`, `alternative` (do something else instead) or
`undetermined`. All three found the same two problems, the price leak and the join bug, but their bottom lines
differ: "not like this" versus "fix the query, maybe no cache at all". If the answers were merged into one, that
difference would be lost.

The agent that asked (the *lead*) does not stop at reading the findings. It checks them in its own repository:

```
finding   the query joins inventory and reviews together, so stock is multiplied by the number of reviews
  checked   ran the query on a test table: 5 units in stock, 4 reviews -> the API reports 20
  so        fix the query first. this bug was there before any cache, and caching would have hidden it

finding   a gold member's 10% discount would be served to guests
  checked   no login middleware is registered yet, so today everyone gets the base price.
            the leak starts the day login is added
  so        cache only the user-independent product row and compute the price on each request
```

What comes back to you is not a vote of "2 against, 1 alternative". It is what was checked, what the lead
recommends, and what has not been checked yet (here: whether the fixed query is fast enough without a cache,
which needs production-like data). You make the call. The checked results stay next to the findings and can be
exported as Markdown into your repository (see [History and records](#history-and-records)).

## How it works

- **You** ask for a consultation, or accept when the agent offers one, and make the final decision.
- **The lead**, the agent you are working with, writes the *brief*: the question, the facts it rests on and the
  relevant code. A routine brief is small: one paragraph of plan, a few lines of facts, one code excerpt. The lead
  picks the consultants and the [mode](#modes), reads the answers, and checks the findings.
- **Each consultant** answers in a new session of its CLI, started just for this question. It sees the brief and
  nothing else from your conversation.
- **The severally server** starts those sessions, sends the identical brief to each (up to four at once), and
  returns every answer separately. It does not merge them or judge which is right.

```
Claude Code ──(skill)──> severally server ──> codex exec | agy | opencode run | claude -p  (fresh session)
Codex       ──(skill)──> severally server ──> claude -p  | agy | opencode run | codex exec (fresh session)
Antigravity ──(skill)──> severally server ──> codex exec | claude -p | opencode run | agy  (fresh session)
OpenCode    ──(skill)──> severally server ──> codex exec | claude -p | agy | opencode run (fresh session)
```

What a consultant can read and do is under [What a consultant can see and do](#what-a-consultant-can-see-and-do).

## Install

### Requirements

- Node.js 20.10 or newer.
- At least one of the four CLIs, installed and logged in. One is enough: with only Claude Code, you can still ask
  a fresh Claude Code session. CLIs that are not on `PATH` are skipped, by the installer and by the server.
- macOS/Linux: npm's global executable directory on `PATH`. The default (plugin mode, below) installs a
  `severally-mcp` command there for Codex to launch. `--manual` does without it.
- Windows runs natively from PowerShell or Command Prompt; WSL is not required. CLIs are found through
  `PATH`/`PATHEXT` (`.exe`, `.cmd`, `.bat`, paths with spaces included).

### Steps

macOS / Linux:

```bash
git clone https://github.com/coz-a/severally.git
cd severally
npm install                 # fetch dependencies
node scripts/install.mjs    # add --dry-run to print what it would change without changing anything
```

Windows (PowerShell):

```powershell
git clone https://github.com/coz-a/severally.git
cd severally
npm.cmd install
node scripts/install.mjs
```

The installer registers severally with every one of the four CLIs it finds on `PATH`. On macOS/Linux it uses
plugin mode, on Windows manual mode ([Two install modes](#two-install-modes) has the difference).

Then **restart the clients** (a running session does not reload plugins) and check that each one sees
severally. Skip the lines for CLIs you don't have:

```bash
# macOS / Linux (plugin mode)
claude plugin details severally      # Skills (1) / MCP servers (1)
codex  plugin list                   # severally@severally-local  installed, enabled
# Windows, or --manual (manual mode)
claude mcp get severally
codex  mcp get severally
# both
agy      mcp list                    # severally  stdio  enabled
opencode mcp list                    # severally  connected
```

After installation the cloned folder can be moved or deleted; Node.js must stay installed. Keep the folder if
you want to run `npm run init-config` (see [Configuration](#configuration)) or `npm test`, which runs offline
checks against stand-in CLIs and makes no real API calls.

### Two install modes

The installer registers severally in one of two ways: plugin mode by default on macOS/Linux, manual mode on
Windows. Pass `--manual` to use manual mode on macOS/Linux too.

| | Plugin mode (default on macOS/Linux) | Manual mode (`--manual`, default on Windows) |
|---|---|---|
| Claude Code | places the plugin in `~/.claude/skills/severally/` (`severally@skills-dir`) | `claude mcp add --scope user` + copy the Skill on its own |
| Codex | `codex plugin add` from a marketplace copied to `~/.severally/marketplace/` | `codex mcp add` + copy the Skill on its own |
| Antigravity | `agy mcp add` + copy the Skill on its own (there is no plugin route, so both modes are the same) | same |
| OpenCode | `opencode mcp add severally -- …` + copy the Skill on its own (no plugin mechanism, so both modes are the same) | same |
| MCP tool names (allow these in your client to skip its per-call permission prompt) | `mcp__plugin_severally_severally__*` | `mcp__severally__*` |

### What the installer changes

- It copies the server, with its dependencies, to `~/.severally/runtime/severally-mcp.mjs`. Every registration
  points at that copy, not at the cloned folder.
- In plugin mode it also runs a global npm install, which provides the `severally-mcp` command that Codex
  launches. `--skip-global` skips that step and is accepted only when `severally-mcp` on `PATH` already points
  at the copied runtime. Manual mode needs no global install.
- It changes client settings only through each CLI's own commands (`plugin add` / `mcp add`). Before it does
  anything, it backs up each client's settings file (`~/.claude.json`, `~/.codex/config.toml`,
  `~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity-cli/settings.json`,
  `~/.config/opencode/opencode.json(c)`) and any existing Skill directory to `~/.severally/backups/<timestamp>/`,
  naming each backup after its original path.
- Switching modes backs up and then removes the duplicate registration left by the other mode.
- No public marketplace listing is involved. Claude Code needs none, and the Codex marketplace file
  `.agents/plugins/marketplace.json` is copied from this repository.

### Updating

Pull or re-clone the repository, run `npm install` and `node scripts/install.mjs` again, then restart the
clients. The installer checks the new server's syntax and backs up the previous runtime and marketplace files
under `~/.severally/backups/` before replacing them.

- Installed with an older version that registered the cloned folder itself? Add `--force` once to switch the
  existing registrations to the copied runtime. Without it, existing registrations are left as they are.
- `npm run build` is needed only if you change the source: the built server in `plugins/severally/dist/` is
  committed.

## Usage

### Asking

Ask in your own words, in the chat with your agent:

```
> ask Codex whether this migration plan is safe
> get a second opinion on this cache design
> ask everyone before we merge this
```

- **Name a consultant** ("ask Codex", "ask Gemini", "ask GLM", "have Claude review this") and only that one is
  asked. You can name a model too ("ask Claude Opus").
- **Ask for a second opinion without naming anyone, or ask everyone**, and the same brief goes to every other
  CLI you have installed plus a fresh session of your own CLI: up to four consultants, and four consultants'
  worth of quota. The lead may ask fewer when the question is small. To ask just one, name it.
- An answer from your own CLI, whichever model ran it, carries a "same lineage" note so you can tell it apart
  from the other vendors' answers.
- **The agent may offer.** When it is about to ask you to approve a hard-to-reverse change, it offers "consult
  first?" as one of the choices. Nothing is sent unless you pick it.

It is worth it for:

- important design decisions and hard-to-reverse choices (architecture, data migration, concurrency, security,
  pre-publication checks)
- options that stay neck and neck however long you think about them
- two or more failed attempts at the same bug with no new information

**Not for small fixes.** One consultation costs a few minutes and real quota.

### What happens next

Starting a consultation returns immediately. While the answers come in, usually within a few minutes, the
agent can work on something that does not depend on them; it does not go ahead with the plan in question.

Every answer has the same shape: a bottom line, findings with their grounds, what the consultant could not
determine, conditions that would change its judgement, and how to check. It also says whether its grounds were
sufficient or thin. A consultant that fails comes back with the reason (`usage_limit`, `auth`, `timeout` …),
never as "no problems found".

The agent then checks the findings that would change the decision, at least the most decisive one, and tells
you what it checked, what it did
not adopt, and what is still unverified. A check it cannot run itself, such as one that needs another person's
answer, comes back to you with the reason.

**For decisions you will have to justify later** (interfaces, migrations, security, concurrency), the agent
takes extra steps, on its own or when you ask: it pins down the question and success criteria, separates
imposed constraints from its own assumptions, and writes down what it expects the consultants to say, so the
record shows later where they surprised it. It then puts the record as a Markdown file in your repository,
next to the code or wherever the repository keeps decision records. The file is an ordinary change you review
like any other.

### Modes

The lead picks the mode; you can also ask for one ("debate this with Codex"). The cache example above used
`review`.

- `explore` asks the question without showing your plan, so the consultant answers with its own approach first.
  The server enforces this: a first `explore` request that contains the plan is refused.
- `review` shows your plan and asks what is wrong with it.
- `debate` shows your plan together with the opposing claims and asks the consultant to weigh them.

After the first answer the lead can send follow-ups to the same consultant, spent on the points where they
disagree: up to four by default, five rounds in total. The limit is set with an environment variable
(see [Configuration](#configuration)).

### History and records

- Everything is kept on your machine in `~/.severally/history/`. Each round is one file holding the brief that was
  sent, the consultant's answer, and the lead's verdict on each finding with its effect on the decision:
  `confirmed` (it holds here), `not_applicable` (true in general, not in this codebase), `unverifiable` (cannot be
  settled with what the lead can reach) or `unverified` (not checked, with the reason). Verdicts can also be
  added later, from another session.
- The lead can export a consultation as Markdown into your repository.
- The record also keeps which model asked which, and whether you asked for the consultation or accepted the
  agent's offer. Offers you declined are written one per line to `~/.severally/history/offers.jsonl`, so you can
  see later how often you turned the offer down. These are records only: nothing changes how often the agent
  offers or what it may do.

## Configuration

**No configuration needed by default.** At startup the server checks whether `codex` / `claude` / `agy` /
`opencode` are on PATH and drops the ones that are missing. To disable a consultant, change a model, or point
at a specific executable, put a single `~/.severally/config.json` in place. A template can be generated for
your machine:

```bash
npm run init-config            # writes ~/.severally/config.json (never overwrites an existing one)
```

Every key is explained in [CONFIG.md](CONFIG.md); [config.example.json](config.example.json) is a working
example that exercises each one. Precedence is environment variables > config file > auto-detection > defaults.
The config is read once at server startup, so restart the client after changing it. On Windows, write an
executable path with forward slashes (`"bin": "C:/Tools/claude.exe"`) or escaped backslashes
(`"bin": "C:\\Tools\\claude.exe"`).

Server-wide limits, such as the follow-up round limit, are environment variables only, with no key in
`config.json`. They are listed in [CONFIG.md](CONFIG.md#not-configurable-in-configjson).

## What a consultant can see and do

A consultation sends the brief to that CLI's model, the same way using the CLI yourself does. Your conversation
history is never sent. No consultant can:

- write files
- use MCP
- consult anyone else
- use the network, except for web search and browsing

| Consultant | Reads files | Shell | Writes | Web search / browsing |
|---|---|---|---|---|
| Codex | yes | yes, in a read-only sandbox (commands run, but cannot write or reach the network) | no | yes |
| Claude Code | yes (`Read` / `Glob` / `Grep`) | none | no | yes |
| Antigravity | yes (`read_file`) | none | no | yes |
| OpenCode | yes (`read` / `glob` / `grep`) | none | no | yes |

Every consultant starts in an empty working directory, and the server does not tell it where your repository
is. It can still read any file your user account can read. Credentials are masked in the brief that is sent and
in the answers that come back; a file a consultant opens on its own is read as it is.

Normally the lead pastes what a consultant should see into the brief. When a consultant needs to look around part
of your repository instead, the lead can name absolute paths (`expose_paths`). Those files and directories are
copied read-only into the consultant's working directory (under `./workspace`): at most 20 entries, 500 files
and 5 MB in total; symlinks are skipped rather than followed; text files are credential-masked exactly as the
brief is, binary files are copied unchanged. The copy is deleted with the job, and the history keeps only which
paths were shown, not their contents. For that consultation the Claude Code consultant reads only the copy; the
other three can still read the rest of the disk as above.

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
