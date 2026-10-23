<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/images/logo-dark.png">
    <img src="assets/images/logo.png" alt="severally" width="480">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/coz-a/severally/actions/workflows/test.yml"><img src="https://github.com/coz-a/severally/actions/workflows/test.yml/badge.svg" alt="Test"></a>
</p>

<p align="center">English | <a href="README.ja.md">日本語</a></p>

A plugin that lets your AI agent ask other coding agents for independent opinions, returned separately.

The consultants are Codex, Claude Code, Antigravity and OpenCode. Your agent (the lead) consults when an
investigation stalls or two options look equally good. You can also ask for a consultation yourself: "ask Codex".

Each consultant's answer stays separate. The lead checks the findings and the reasons behind disagreements
itself, then carries on from what it found. For an important decision, such as a change that is hard to reverse,
it consults before asking you to approve it, and asks you only about what is yours to decide.

Asked whether to cache a slow product page for five minutes, three consultants answered on their own
(see the [example](docs/how-it-works.md#example) for the whole run):

```text
codex        do_not_proceed  the price depends on the member's tier, so the first visitor's price is served to everyone
claude-code  do_not_proceed  whoever fills the cache first sets the price everyone else sees for 5 minutes
antigravity  alternative     member discounts leak to other users; fix the query and a cache may not be needed
```

In that example, the lead reproduced inflated stock in a test database and chose to fix the query first.
It also checked that login was not yet wired in: the price leak would begin when login was added, so it
recommended caching only user-independent product data. Whether the fixed query was fast enough remained unverified.

## Contents

- [Install](#install)
  - [Requirements](#requirements)
  - [Command line](#command-line)
  - [Updating](#updating)
  - [Uninstall](#uninstall)
- [Usage](#usage)
  - [Asking](#asking)
  - [When the answers come back](#when-the-answers-come-back)
  - [Modes](#modes)
  - [Follow-ups](#follow-ups)
  - [History and records](#history-and-records)
- [Configuration](#configuration)
- [What a consultant can see and do](#what-a-consultant-can-see-and-do)
- [API](#api)
- [Contributing](#contributing)
- [License](#license)

## Install

### Requirements

- Node.js 22 or newer
- At least one of the four CLIs, installed and logged in. One is enough: with only Claude Code, you can still ask a
  fresh Claude Code session.

Prepare the CLI you want to consult using the [installation and login links](docs/install.md#requirements).
The command below installs severally and registers it with existing CLIs; it does not install or log in to those CLIs.

The installer and the server are tested on Linux, macOS and Windows; the Claude Code and Codex marketplace
routes and the real CLIs have been tried on Linux only. On Windows, cancelling a consultation stops its process
tree while the consultant's CLI is still running; processes it started may survive if the CLI has already exited.
That case has not been verified on a real Windows machine.

One line, on macOS, Linux and Windows (PowerShell or Command Prompt):

```bash
npx -y severally-mcp@2.8.0 install
```

The installer registers severally with each CLI it finds on `PATH`. Add `--dry-run` at the end to print what it
would change without changing anything.

Then restart the clients: a running session does not reload the new registration. To check the setup without
starting a consultation, run:

```bash
npx -y severally-mcp@2.8.0 status
```

It shows the config file, the consultants this machine can reach, the installed copies' versions, which clients
have severally registered and whether each CLI is logged in. The login check reads the CLI's own status command and
sends no prompt; running out of quota is not checked, and the first consultation shows it.

Part of the output on a machine with Codex and Claude Code:

```text
config: ok

consultants:
  codex: codex, gpt-6.1-sol  available
  claude-code: claude-code, claude-opus-5-5  available

clients:
  Claude Code  registered (listed by the client)
  Codex        registered (listed by the client)

login (out of quota is not checked; the first consultation shows it):
  codex        logged in
  claude-code  logged in
```

No configuration is normally needed. To ask the first question, see [Asking](#asking).

Marketplace installs, installing from a clone, and the fallback when global npm installation is unavailable are
in the [installation details](docs/install.md).

### Command line

See [installer options](docs/install.md#command-line) for `--dry-run`, `--manual`, `--force` and the other flags.

### Updating

This line replaces your install with the latest version, with no version number to look up:

```bash
npx -y severally-mcp@latest install
```

With `@latest`, npx asks npm for the newest version every time, so an older copy it already has is not used.
If Claude Code has severally from its plugin marketplace, the same line updates that copy too (details in
[docs/install.md](docs/install.md#updating)). Then restart the clients. What changed in each version is in the
[releases](https://github.com/coz-a/severally/releases).

### Uninstall

Installed from the marketplace: run `/plugin marketplace remove severally` in Claude Code, which also removes the
plugin. For an installer install, the commands for each OS and install mode are in
[docs/install.md](docs/install.md#uninstall). Either way, history and backups stay in `~/.severally/`; delete it
if you no longer need them.

## Usage

### Asking

In your restarted agent's chat, ask:

```text
Ask Codex: Our read-only public API gets 100 requests per minute.
Updates may appear 60 seconds late. Is a 30-second cache reasonable?
```

If Codex is not installed, use a consultant marked `available` by `status`. A report looks like this; the
answering model, checks and unverified points depend on the consultation:

```text
Codex (gpt-6.1-sol) suggested a 30-second cache: it is within the 60-second allowance.
Delays from other cache layers are unverified; check that their combined delay stays
within 60 seconds before adopting it.
```

Then ask: "Ask the same consultant what changes if updates must appear within five seconds."

Ask in your own words, and include the premises in your question. For code questions, name the files or the
change:

```text
> ask Codex whether this migration plan is safe
> get a second opinion on this cache design
> ask everyone before we merge this
```

- Name a consultant ("ask Codex", "ask Claude Opus") and only that one is asked. A CLI's name works, and so
  does a model's.
- Ask for a second opinion without naming anyone, or ask everyone, and the same brief goes to every
  consultant, a fresh session of your own CLI included. That is one consultation's quota per consultant.
- The agent also consults without being asked: when an investigation stalls, when two options look equally
  good, and before asking you to approve a hard-to-reverse change.

What comes back to you is the lead's report, not the consultants' answers as they arrived: what it checked and
what that showed, what it recommends, and what is still unverified. The [example](docs/how-it-works.md#example) shows one.

It is worth it for important design decisions, hard-to-reverse choices, and two or more failed attempts at the
same bug. One consultation takes minutes and real quota, so it is not for small fixes.

### When the answers come back

Starting a consultation does not make the agent wait: it can work on something that does not depend on the
answers, which usually arrive within one to ten minutes. Timing depends on the CLI, model and load.

Every answer is asked for in the same shape: a bottom line, findings with their grounds, what the consultant could
not determine, conditions that would change its judgement, and how to check. When an answer leaves part of that
out, such as the bottom line or the grounds for a finding, it says so in a caveat. A consultant that fails comes
back as a failure with the reason (`usage_limit`, `timeout` …), never as "no problems found".

The agent checks the findings that would change the decision itself, then tells you what it checked, what it did
not adopt, and what is still unverified.

For example, in a review of the classifier before its authentication-priority fix, the result and the lead's
verification were separate:

```text
Codex (gpt-6.1-sol): “429 invalid api key” is misclassified as a transient limit.
Lead: ran the classifier, reproduced rate_limited, and saved the finding as confirmed.
Recommendation: classify authentication before transient limits. Provider-specific quota behavior remains untested.
```

### Modes

There are three modes, chosen from what the agent hands over. You can also ask for one ("debate this with
Codex").

- `explore`: asks without showing the plan, so the consultant answers with its own approach first
- `review`: shows the plan and asks what is wrong with it (the [example](docs/how-it-works.md#example))
- `debate`: shows the plan with the opposing claims, and asks the consultant to weigh them


### Follow-ups

After the first answer, the agent can send follow-ups to the same consultant: up to four by default, five rounds
in total. A follow-up to a fan-out asks every consultant in it again, each continuing its own exchange; one that
cannot continue is skipped, and the reason is listed.

- The files of the earlier round are handed over again, as they are now: changes and deletions are noted, a
  directory is listed afresh (files added since go too), and the agent can add more. It can also ask for a
  text-only follow-up.
- They go again only if the consultant still runs the CLI and model of the earlier round (a fallback model set for
  it counts). Otherwise the agent names the files again.

### History and records

Every consultation is kept on your machine in `~/.severally/history/`: the brief that was sent, the consultant's
answer, and the agent's verdict on each finding (`confirmed`, `not_applicable`, `unverifiable`, `unverified`).
For Codex and Antigravity it also keeps the commands run or the paths opened, with how many of the files handed
over they name; secrets are masked and command output is not kept. Verdicts can be added later, from another session. A consultation can be exported as Markdown into your
repository.

The [product-cache example](docs/how-it-works.md#example) follows each consultant's recommendation through the
lead's checks and decision. Naming consultants, the consultation flow and record details are also in
[how it works](docs/how-it-works.md).

## Configuration

**No configuration needed by default.** At startup the server looks for the CLIs on `PATH`, and each one it finds
becomes a consultant on its default model. To turn a CLI off or add consultants on other models, put a
`~/.severally/config.json` in place. From a clone, `npm run init-config` writes a template. Every key is in
[CONFIG.md](CONFIG.md), and [config.example.json](config.example.json) is an example to adapt: its paths, models and notes are made up.
For separate models for everyday work and consultations, see the optional
[multi-model example](docs/how-it-works.md#recommended-setup). Restart the client after changing the config.

To consult a model you reach with an API key (OpenRouter, or another OpenAI-compatible API) or a local model,
install OpenCode and add the model as a consultant: see
[CONFIG.md](CONFIG.md#api-keys-and-other-model-families-through-opencode).

## What a consultant can see and do

A consultation sends the brief to that CLI's model, the same way using the CLI yourself does. It does not
automatically inherit your parent session's history: anything the lead includes in the brief is sent, and files
the consultant is allowed to read also go to its model. The read-only setting does not isolate what it can read.
No consultant can:

- write files
- use MCP
- start other agents or consult anyone else
- use the network, except for web search and browsing

| Consultant | Reads files | Credential paths | Shell | Writes | Web search / browsing |
|---|---|---|---|---|---|
| Codex | yes | blocked by path (permission profile), not by file name such as `.env` | yes, in its sandbox (commands run, but cannot write or reach the network) | no | yes, unless `network: "off"` |
| Claude Code | yes (`Read` / `Glob` / `Grep`) | blocked (permission rules) | none | no | yes, unless `network: "off"` |
| Antigravity | yes (`view_file`, `read_file`) | blocked (tool hook) | none | no | yes, unless `network: "off"` |
| OpenCode | yes (`read`) | blocked by lexical path; symlink aliases are not covered | none (its Code Mode `execute` is refused) | no | yes, unless `network: "off"` |

Every consultant starts in a working directory of its own that holds only copies of the files you handed it, and
the server does not tell it where your repository is. It can still read any file your user account can read, except
the credential paths the table marks blocked. The one exception is Claude Code in a consultation that exposes files:
it can then read only those copies.
Codex does not block by file name, so a `.env` in your repository is readable to it.
Its protection also misses files created later under `~/.codex` and, on Linux, protected files replaced by rename
during a run. Credentials stored outside the configured protected paths are not covered.

**A consultant that can both read your disk and browse could carry what it read out in a URL**, for example if a
page it opens tells it to. To prevent that, the agent passes `network: "off"`: every consultant in that round then
has no web search or browsing. To make that the rule for every consultation, set `"server": { "network": "off" }`
in the [config file](CONFIG.md#server-wide-keys); a request cannot turn it back on. The brief, and whatever a
consultant reads, still goes to that CLI's model.

How each CLI is held to this is in [docs/how-it-works.md](docs/how-it-works.md#how-a-consultant-is-kept-to-reading).

## API

The server has six MCP tools. Of these, only `consult_start` starts an external consultation, sending the brief
and exposed files to each consultant's model. Once started, a consultant can read files or browse within its
permissions; those contents can also leave the machine. The other five tools operate on local consultation
state and records. Every argument is described in the tool descriptions the agent reads.

| Tool | What it does |
|---|---|
| `consult_start` | Starts a consultation with one consultant (`target`) or several (`targets`), and returns a `job_id` or `group_id` at once |
| `consult_get` | Waits for a consultation and returns its state or answer; with `ids`, just those points of the answer |
| `consult_cancel` | Stops a consultation or a whole fan-out, and its consultant processes, also one another session started |
| `consult_record` | Writes the lead's verdicts on an answer's points, and what the answer added |
| `consult_list` | Lists recent consultations, earlier sessions' included, with the usage each consultant reported in this session |
| `consult_export` | Returns a consultation, follow-ups and verdicts included, as Markdown |

Arguments and file exposure are described in [How it works](docs/how-it-works.md#api-arguments).

## Contributing

Questions and bug reports go to [Issues](https://github.com/coz-a/severally/issues). Pull requests are welcome; for
a large change, open an issue first so we can talk it over. Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

- `npm install`, then `npm test`. The tests run offline against stand-in CLIs and make no real API calls.
- CI also runs `npm run lint`, `npm run typecheck` and `npm run format:check`. Run them before you open a pull
  request.
- After changing the source or the Skill template, run `npm run build`. The built server in
  `plugins/severally/dist/` and the generated Skills are committed, and CI fails when they are out of date.
- `npm run live-check` and `npm run doctor` run real consultations against the CLIs you have installed, and spend
  real quota.

## License

[Apache-2.0](LICENSE) © 2026 coz.a
