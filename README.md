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

For example, a cache review can reveal that member-specific prices would leak to other users. The lead
checks the pricing assumptions, chooses what can be cached, and records what remains unverified. When the
code changes, it sends those checks and the current files to the same consultant. The
[worked example](docs/how-it-works.md#example) follows the separate recommendations through that decision.

Consultations send the brief, exposed files and anything the consultant reads to that CLI's model.
Asking everyone spends quota per consultant. Read restrictions have CLI-specific gaps and untested environments;
turning off the web still sends material to the model. See [what is sent and the protection limits](#what-a-consultant-can-see-and-do).

## Contents

- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [What a consultant can see and do](#what-a-consultant-can-see-and-do)
- [API](#api)
- [Contributing](#contributing)
- [License](#license)

## Install

### Requirements

- Node.js 22 or newer. Some OpenCode 2.x authentication recovery needs `node:sqlite`; `status` reports whether
  it is available. Normal login can still work without it. See [recovery requirements](docs/install.md#requirements).
- At least one of the four CLIs, installed and logged in. One is enough: with only Claude Code, you can still ask a
  fresh Claude Code session.
- Windows 10+ with built-in PowerShell 5.1 and permission to use .NET `Add-Type`; see [platform requirements](docs/install.md#requirements).

Prepare the CLI you want to consult using the [installation and login links](docs/install.md#requirements).

### Installing

The command below installs severally and registers it with existing CLIs; it does not install or log in to those CLIs.
One line, on macOS, Linux and Windows (PowerShell or Command Prompt):

```bash
npx -y severally-mcp@2.14.0 install
```

If npm selects an existing global server from this source checkout, explicitly select the installer:

```bash
npx --yes --package=severally-mcp@2.14.0 -- severally-install
```

The installer registers severally with each CLI it finds on `PATH`. Add `--dry-run` at the end to print what it
would change without changing anything.

Then restart the clients: a running session does not reload the new registration.
No configuration is normally needed. Continue with the [first question](#asking).

To check the registration, see [CLI](#cli). Other install routes and platform-specific notes are in the
[installation details](docs/install.md).

## Usage

### Asking

First check which consultant CLIs are detected, without starting a consultation or spending quota:

```bash
npx -y severally-mcp@2.14.0 status
```

`available` means the CLI was found, not that login or a live consultation has been verified.
If Codex is detected, ask in your restarted agent's chat. If only another CLI is installed, substitute its name:

```text
Ask Codex: Our public API must return data no more than 60 seconds old.
The upstream data may already be 40 seconds old when fetched; assume zero fetch time.
Is a fixed 30-second TTL reasonable? State the conditions and the smallest useful check.
```

An illustrative report follows. Actual answering models, point IDs and check results depend on the consultation:

```text
Recommendation: revise the 30-second proposal; under these assumptions, use TTL <= 20 seconds.
Codex (gpt-6.1-sol, f1) said upstream age and cache residence must be added.
The lead checked the counterexample 40 + 29 = 69 seconds and rejected the 30-second proposal.
Refreshing at the expiry boundary (elapsed >= 20 seconds) has not yet been tested.
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
same bug. A consultation takes time and real quota, so it is not for small fixes.

### CLI

Use the terminal to install or check the registration:

```bash
npx -y severally-mcp@2.14.0 install
npx -y severally-mcp@2.14.0 status
```

`status` shows configuration, available consultants, registrations and login without starting a consultation
or sending a prompt. It does not check remaining quota. See the [output and checks](docs/install.md#checking-the-registration),
[installer options](docs/install.md#command-line), [updating](docs/install.md#updating) and
[uninstalling](docs/install.md#uninstall). Restart the clients after updating.

From a source checkout, diagnose an authenticated CLI with:

```bash
node scripts/doctor.mjs --target codex
```

This starts real consultations and spends quota. See [what it checks and its limits](docs/install.md#checking-cli-compatibility-after-an-update).
Ask for consultations, follow-ups and Markdown exports in your agent's chat.

### Answers, checks and failures

The agent can work on independent tasks while it waits. Time varies with the CLI, model and load. The default
budget for the whole consultation is 30 minutes, separate from one `consult_get` wait; it can be configured.
When asking several consultants, the lead can check the first answers while the others continue.
Each answer includes a stance, a separate concrete recommendation, findings with grounds, unknowns and proposed checks.
Matching stances can recommend different options; older answers without a recommendation remain not declared.
A failure (`usage_limit`, `timeout` and so on) means no advice was obtained.

The lead checks the claims that could change the decision and records evidence separately from adoption.
It reports each consultant's actual model, the deciding point and its ID, what the check showed, its
recommendation and what remains unverified. Different conclusions stay separate. If one consultant fails,
the successful answers remain usable; the agent can retry just the failed consultation when needed.

Ask "Stop the current consultation" to cancel, or "Check the answers that have arrived first" to use partial
success. A timeout can mean the brief needs narrowing or the budget needs increasing; an authentication
failure needs a login check with `status` before retrying. Cancellation requests process termination.
Windows uses a launch Job to stop ordinary descendants even after the CLI exits; see the
[requirements and stop limits](docs/how-it-works.md#records).

### Follow-ups and history

Ask “Continue yesterday's cache consultation” or “Recheck that finding against the updated code.” The agent
can find the saved consultation and continue with the same consultant; you do not need to copy IDs. When
several candidates fit, it checks which one you mean. By default a chain permits five rounds in total.
Each follow-up starts a fresh CLI session with the saved question, answer and checks; it does not resume the
CLI's native session. Files are sent again in their current state, with changes and deletions noted.

Consultations and verification records stay in `~/.severally/history/`. They can be updated from a later
session or exported as Markdown with verified points, decision effects and unchecked counts before the full
answers. A confirmed point means the check supported it within the recorded scope; it does not mean the lead adopted
the advice. `refuted` means it did not hold in that check. Partial checks stay `unverified` with their limits recorded.
See [modes and follow-up details](docs/how-it-works.md#how-a-consultation-runs) and
[records](docs/how-it-works.md#records).

## Configuration

**No configuration needed by default.** At startup the server looks for the CLIs on `PATH`, and each one it finds
becomes a consultant on its default model. To turn a CLI off or add consultants on other models, put a
`~/.severally/config.jsonc` or `config.json` in place (`config.jsonc` takes precedence). From a clone, `npm run init-config` writes a template. Every key is in
[CONFIG.md](CONFIG.md), and [config.example.json](config.example.json) is an example to adapt: its paths, models
and notes are made up. For separate models for everyday work and consultations, see the optional
[multi-model example](docs/how-it-works.md#recommended-setup). Restart the client after changing the config.

To consult a model you reach with an API key (OpenRouter, or another OpenAI-compatible API) or a local model,
install OpenCode and add the model as a consultant: see
[the four-step OpenCode setup](CONFIG.md#api-keys-and-other-model-families-through-opencode).

## What a consultant can see and do

A consultation sends the brief to that CLI's model, the same way using the CLI yourself does. It does not
automatically inherit your parent session's history: anything the lead includes in the brief is sent, and files
the consultant is allowed to read also go to its model. The read-only setting does not isolate what it can read.
The server configures each consultant to prohibit:

- writing files
- using MCP
- starting other agents or consulting anyone else
- using the network, except for web search and browsing

| Consultant | Reads files | Credential paths | Shell | Writes | Web search / browsing |
|---|---|---|---|---|---|
| Codex | yes | blocked by path (permission profile), not by file name such as `.env` | yes, in its sandbox (commands run, but cannot write or reach the network) | no | yes, unless `network: "off"` |
| Claude Code | yes (`Read` / `Glob` / `Grep`) | blocked (permission rules) | none | no | yes, unless `network: "off"` |
| Antigravity | yes (`view_file`, `read_file`) | blocked (tool hook) | none | no | yes, unless `network: "off"` |
| OpenCode | yes (`read`) | permission rules and a pre-read realpath guard; limits below | none (its Code Mode `execute` is refused) | no | yes, unless `network: "off"` |

Every consultant starts in a working directory of its own that holds only copies of the files you handed it, and
the server does not tell it where your repository is. It can still read any file your user account can read, except
the credential paths the table marks blocked. The one exception is Claude Code in a consultation that exposes files:
it can then read only those copies.
Codex cannot deny by name, so a repository's `.env` is readable. A Codex executable inside a credential root
is refused before consultation starts: install it outside those roots and check placement with `status`.
Individually denied files replaced by rename and legacy job homes created after launch remain limitations.
Do not run pre-1.7 severally alongside current consultations. OpenCode cannot guarantee reads against a path
replacement between its guard and the read. The [mechanisms, tested conditions and limits](docs/how-it-works.md#how-a-consultant-is-kept-to-reading)
state the CLI, OS and version scope. Arbitrary credential locations are not automatically found.
On Windows, Codex's elevated sandbox may need initial administrator approval.

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
| `consult_start` | Starts one (`target`) or several (`targets`) consultations; `retry_of` replays only a failed job |
| `consult_get` | Waits for a consultation and returns its state or answer; with `ids`, just those points of the answer |
| `consult_cancel` | Requests termination of a consultation and its processes, including a group or another session's work. See [stop limits](#answers-checks-and-failures) |
| `consult_record` | Writes the lead's verdicts on an answer's points, and what the answer added |
| `consult_list` | Finds consultations by consultant, question or chain; includes continuation IDs and session usage |
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
  real quota. `doctor` also prints each CLI's version. Before a release, run both against the CLIs on hand and put the
  versions, the date and the OS in the release notes.

## License

[Apache-2.0](LICENSE) © 2026 coz.a
