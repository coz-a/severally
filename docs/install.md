# Installing severally: the details

<p>English | <a href="install.ja.md">日本語</a></p>

What the [README](../README.md#install) leaves out of installing. For an ordinary install, the README's one line is
enough.

npx fetches the package into its cache and runs the installer from there; nothing that is installed points back
into that cache, so it can be cleared afterwards.

## Requirements

Install and sign in to at least one consultant CLI before installing severally. Choose the ones you want;
you do not need all four. These official guides cover installation and authentication:

| CLI | Installation and login |
|---|---|
| Codex | [Install](https://developers.openai.com/codex/cli) · [Sign in](https://learn.chatgpt.com/docs/auth) |
| Claude Code | [Install and authenticate](https://code.claude.com/docs/en/setup) |
| Antigravity | [Install](https://antigravity.google/docs/getting-started?tab=cli) · [Authenticate](https://antigravity.google/docs/install?tab=cli) |
| OpenCode | [Install](https://dev.opencode.ai/v2/docs) · [Connect a provider](https://dev.opencode.ai/v2/docs/providers) |

Open a new terminal after installation so the CLI is on `PATH`. severally uses the CLI's existing login;
its installer prepares the server and client registration, not the consultant's account.

Beyond Node.js 22 or newer and a logged-in CLI, as in the README:

- macOS/Linux: nothing about npm's global folder is required. The default (plugin mode, below) runs
  `npm install -g` to put a `severally-mcp` command on `PATH` for Codex's plugin to launch. When npm cannot install
  it globally (for example it needs sudo, or npm's global folder is not on `PATH`), the installer registers Codex
  directly instead, and nothing else is needed. `--manual` does without the command.
- Windows runs natively from PowerShell or Command Prompt; WSL is not required. CLIs are found through
  `PATH`/`PATHEXT` (`.exe`, `.cmd`, `.bat`, paths with spaces included).

## Command line

```bash
npx -y severally-mcp@2.6.2 install [--dry-run] [--manual] [--force] [--skip-global] [--allow-local-tools]
```

| Option | What it does |
|---|---|
| `--dry-run` | prints what it would change, and changes nothing |
| `--manual` | registers the MCP server and copies the Skill instead of installing the plugin (the default on Windows) |
| `--force` | registers again where severally is already registered, instead of leaving it as it is |
| `--skip-global` | skips the global npm install in plugin mode, when `severally-mcp` on `PATH` is already this install |
| `--allow-local-tools` | adds severally's five local tools to Claude Code's allow list without asking; `consult_start` still asks |


## From a clone

On macOS / Linux:

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

After installation the cloned folder can be moved or deleted; Node.js must stay installed. Keep it if you want to
run `npm run init-config` (see [Configuration](../README.md#configuration) in the README).

## Checking the registration

`npx -y severally-mcp@latest status` shows it all at once, without starting a consultation: whether the config
file is valid, which consultants this machine can reach (and why the others cannot), whether every installed copy
is the same version, which clients have severally registered, and whether each CLI is logged in. The login check
reads each CLI's own status command and sends no prompt: `claude auth status` for Claude Code, `codex login status`
for Codex, and for OpenCode the number of credentials saved by `opencode auth list` (keys in the environment also
work, so none saved is only a warning). Antigravity has no such command, so it shows "not checked". Running out of
quota is not checked; the first consultation shows that.

To check one client yourself, after restarting it. Skip the lines for CLIs you don't have:

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

## From the Claude Code plugin marketplace

For Claude Code alone, no clone and no installer are needed. In Claude Code:

```
/plugin marketplace add coz-a/severally
/plugin install severally@severally
```

Restart Claude Code and check with `claude plugin details severally`. Node.js 22 or newer must be on `PATH`,
since the plugin starts its server with `node`. The tools appear as `mcp__plugin_severally_severally__*`. This
route has been tried on Linux only.

To use severally from Codex, Antigravity or OpenCode as well, also run the installer from a clone
([From a clone](#from-a-clone)). It finds the marketplace plugin and leaves Claude Code to it. If you ran the installer before
adding the marketplace plugin, run it once more: Claude Code would otherwise load severally twice, and the
installer removes its own Claude Code copy and registration, backing them up first. Once the marketplace plugin is
there, the same installer run also updates it (see [Updating](#updating)).

## Two install modes

The installer registers severally in one of two ways: plugin mode by default on macOS/Linux, manual mode on
Windows. Pass `--manual` to use manual mode on macOS/Linux too.

| | Plugin mode (default on macOS/Linux) | Manual mode (`--manual`, default on Windows) |
|---|---|---|
| Claude Code | places the plugin in `~/.claude/skills/severally/` (`severally@skills-dir`) | `claude mcp add --scope user` + copy the Skill on its own |
| Codex | `codex plugin add` from a marketplace copied to `~/.severally/marketplace/` | `codex mcp add` + copy the Skill on its own |
| Antigravity | `agy mcp add` + copy the Skill on its own (there is no plugin route, so both modes are the same) | same |
| OpenCode | `opencode mcp add severally -- …` + copy the Skill on its own (no plugin mechanism, so both modes are the same) | same |
| MCP tool names | `mcp__plugin_severally_severally__*` | `mcp__severally__*` |

## What the installer changes

- It copies the server, with its dependencies, to `~/.severally/runtime/severally-mcp.mjs`. Every registration
  points at that copy, not at the cloned folder.
- In plugin mode on macOS/Linux it also runs a global npm install of the runtime under the package name
  `severally-runtime`, which provides the `severally-mcp` command that Codex's plugin launches. A global package
  named `severally-mcp` that an earlier install left is removed with `npm uninstall -g severally-mcp` first.
  If npm cannot install the command globally, or it is not first on `PATH`, the installer does not stop: it
  registers Codex directly, with the same `codex mcp add` registration and long `consult_get` wait as `--manual`,
  and says so. `--skip-global` skips the global install and is accepted only when `severally-mcp` on `PATH` already
  points at the copied runtime. Manual mode needs no global install.
- It changes client settings only through each CLI's own commands (`plugin add` / `mcp add`), with one
  exception: for a manually registered Codex it also writes one line, `tool_timeout_sec = 660`, into
  `config.toml` under `[mcp_servers.severally]` (the same long wait the Codex plugin has; `codex mcp add` cannot
  set it). An existing `tool_timeout_sec` there is kept, and the wait follows it. If the line cannot be written,
  Codex is registered without the long wait and the installer says so.
- Before it does anything, it backs up each client's settings file (`~/.claude.json`, `~/.codex/config.toml`,
  `~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity-cli/settings.json`,
  `~/.config/opencode/opencode.json(c)`) and any existing Skill directory to `~/.severally/backups/<timestamp>/`,
  naming each backup after its original path.
- Switching modes backs up and then removes the duplicate registration left by the other mode.
- If Claude Code already has severally from the marketplace, the installer does not register it with Claude Code,
  and removes its own earlier Claude Code copy (`~/.claude/skills/severally`) and user-scope registration. It also
  updates the marketplace copy (see [Updating](#updating)).
- At the end, if Claude Code is present and `~/.claude/settings.json` does not yet allow severally's five local
  tools, it offers to add them (see the next section). It changes nothing else in that file.
- For Codex, the marketplace file `.agents/plugins/marketplace.json` is copied from this repository; no public
  listing is involved.

## Skipping the permission prompt for tools that send nothing out

Every tool except `consult_start` stays on your machine: `consult_get` (called repeatedly while a
consultation runs), `consult_list`, `consult_cancel`, `consult_record` and `consult_export`. Keep `consult_start` prompting: it is the point where
material leaves for another vendor, and the installer never adds it.

- **Claude Code**: the Skill already allows these five tools (its `allowed-tools`) for the turn it is invoked in, so
  polling a consultation does not prompt each time; the Skill itself asks for approval once. For the later turns
  (recording verdicts, a follow-up), the installer offers to add them. At the end of the install, if Claude Code is
  present and `~/.claude/settings.json` does not yet allow the five tools, it asks at the terminal "Let Claude Code
  run ... without asking each time? [Y/n]" (the default is yes). With `--allow-local-tools` it adds them without
  asking, for scripted installs. Without a terminal and without the flag it changes nothing and prints how to rerun
  with the flag. It backs up `settings.json` first, keeps every other setting, and never adds a rule twice. The
  rules use the prefix `mcp__plugin_severally_severally__` in plugin mode or for a marketplace install, and
  `mcp__severally__` in manual mode. To do it by hand, add this to `~/.claude/settings.json` (write
  `mcp__severally__` instead of `mcp__plugin_severally_severally__` for `--manual`):
  ```json
  { "permissions": { "allow": [
    "mcp__plugin_severally_severally__consult_get", "mcp__plugin_severally_severally__consult_list",
    "mcp__plugin_severally_severally__consult_cancel", "mcp__plugin_severally_severally__consult_record",
    "mcp__plugin_severally_severally__consult_export"
  ] } }
  ```
- **Codex**, in `~/.codex/config.toml`, one table per tool, for a server registered with `codex mcp add`
  (`--manual`). codex 0.163 accepts the key (`auto`, `prompt`, `writes` or `approve`); the effect in a session
  and the plugin install have not been checked:
  ```toml
  [mcp_servers.severally.tools.consult_get]
  approval_mode = "approve"
  ```
- **OpenCode** allows MCP tools without asking unless your own `permission` settings say otherwise.
- **Antigravity**: not covered here; the rule syntax for a single MCP tool has not been checked.

The installer does not touch the permissions of Codex, Antigravity or OpenCode.

### Letting consultations start without the prompt too

The agent consults on its own (the Skill tells it not to ask whether to), so with `consult_start` prompting, every
consultation it starts waits for you once. That prompt is the only check before material leaves your machine, so it
stays by default. To drop it, add `consult_start` the same way as the tools above:
`mcp__plugin_severally_severally__consult_start` in Claude Code's allow list, or a
`[mcp_servers.severally.tools.consult_start]` table in Codex's `config.toml` (for a `--manual` registration; not
checked for the plugin install).

From then on, each consultation sends these to every consultant's model without asking you: the brief, the files
it exposes, and whatever the consultant reads while it runs (see
[What a consultant can see and do](../README.md#what-a-consultant-can-see-and-do)). Do it only where everything the
agent can reach may go to those vendors.

## Updating

When developing from a clone, run `npm run build` and then `node scripts/install.mjs` again to copy the generated
server and Skills into the client installs. Add `--force` if an existing direct registration needs replacing.
Restart the clients afterwards.


Run `npx -y severally-mcp@latest install`, or pull the clone and run `npm install` and
`node scripts/install.mjs` again. The installer checks the new server's syntax and backs up the previous runtime
and marketplace files under `~/.severally/backups/` before replacing them. Then restart the clients.

Installed with an older version that registered the cloned folder itself? Add `--force` once to switch the
existing registrations to the copied runtime. Without it, existing registrations are left as they are.

Installed from the marketplace: when Claude Code already has severally from the marketplace, the installer also
runs `claude plugin marketplace update severally` and `claude plugin update severally@<marketplace>`, so one
`npx -y severally-mcp@latest install` brings every copy to the same version. If that fails, it prints the command to
run inside Claude Code, `/plugin marketplace update severally`. Restart Claude Code afterwards. For Claude Code
alone you can also run that command yourself instead of the installer. Automatic updates are off by default; to
turn them on, select severally under Marketplaces in `/plugin`, then Enable auto-update. Codex, Antigravity and
OpenCode run their own copy in `~/.severally/runtime`, and both copies read the same `~/.severally/config.json`;
the installer keeps them on the same version, which matters when a release changes the config format. When the copy in `~/.severally/runtime` or
`~/.claude/skills/severally` runs a different version from the server answering, `consult_start` says so under
`stale_install`, with the copies' versions and the commands that bring them level.

## Uninstall

Installed from the marketplace (Claude Code), in Claude Code:

```
/plugin marketplace remove severally    # also uninstalls the plugin
```

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
# Only if you installed the global command earlier (the old name is for an earlier install):
npm.cmd uninstall -g severally-runtime
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
npm uninstall -g severally-runtime
npm uninstall -g severally-mcp    # only if an earlier install left it
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
# Only if a global command was installed earlier (the old name is for an earlier install):
npm uninstall -g severally-runtime
npm uninstall -g severally-mcp
rm -rf ~/.severally/runtime ~/.severally/marketplace
```

Either way, history and backups stay in `~/.severally/` (delete it if you no longer need them).
