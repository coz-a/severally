# Configuration reference

`~/.severally/config.json` (or `config.jsonc`, or a path set by `SEVERALLY_CONFIG`) is the one file an
operator edits to change severally's behavior on a machine — which consultants are on, which model each
runs, and so on. Generate a starting point for the current machine with:

```bash
npm run init-config            # writes ~/.severally/config.json (never overwrites an existing one)
```

or copy [config.example.json](config.example.json) by hand and trim it to the overrides you actually need —
you do not have to set every key for every target.

**Precedence, per key:** environment variable > config file > auto-detection > built-in default. The file is
read once at server startup, so restart the MCP client after changing it.

**Comments are fine.** `//` and `/* */` comments and trailing commas are stripped before parsing, in both a
`.json` and a `.jsonc` file — use whichever extension your editor is happy with (if it flags comments in
`.json` as an error, name the file `config.jsonc`; both are read the same way).

## Shape

```json
{
  "server": { },
  "targets": {
    "<codex | claude-code | antigravity | opencode>": { }
  }
}
```

`server` holds the limits that apply to the whole server; `targets` holds the settings for each consultant. Both
are optional, and the server reads no other top-level key.

## Per-target keys

| Key | Type | Default | Overriding env var | What it does |
|---|---|---|---|---|
| `enabled` | boolean | `true` if the CLI is found on `PATH` | `SEVERALLY_TARGETS` (comma-separated list; names the whole enabled set at once) | Turns a consultant on/off without uninstalling it. |
| `note` | string | – | – (config-only) | Shown to the caller instead of a bare refusal when the target is unavailable — e.g. `"rate-limited until 15:00"`. |
| `bin` | string | the CLI's usual command name (`codex`, `claude`, `agy`, `opencode`) | `SEVERALLY_CODEX_BIN` / `SEVERALLY_CLAUDE_BIN` / `SEVERALLY_AGY_BIN` / `SEVERALLY_OPENCODE_BIN` | Command name on `PATH`, or an absolute (or `~`-relative) path, when the executable isn't the default one. |
| `default_model` | string | see table below | `SEVERALLY_CODEX_MODEL` / `SEVERALLY_CLAUDE_MODEL` / `SEVERALLY_AGY_MODEL` / `SEVERALLY_OPENCODE_MODEL` | The model a consultation runs when the caller doesn't name one. Always implicitly allowed, even if left out of `allowed_models`. |
| `allowed_models` | array of strings | `[default_model]` | `SEVERALLY_CODEX_ALLOWED_MODELS` / `SEVERALLY_CLAUDE_ALLOWED_MODELS` / `SEVERALLY_AGY_ALLOWED_MODELS` / `SEVERALLY_OPENCODE_ALLOWED_MODELS` (comma-separated) | Models a caller may request by name, e.g. `target: "codex:<model>"`. A name outside this list is refused before the consultant starts. |
| `timeout_ms` | number, 1000–1800000 | the shared timeout (`SEVERALLY_TIMEOUT_MS`, 600000 by default) | `SEVERALLY_CODEX_TIMEOUT_MS` / `SEVERALLY_CLAUDE_TIMEOUT_MS` / `SEVERALLY_AGY_TIMEOUT_MS` / `SEVERALLY_OPENCODE_TIMEOUT_MS` | Per-consultant wall-clock budget, for the one target that reliably needs longer (or shorter) than the rest — e.g. Gemini on an involved request. |
| `effort` | string | `high` (none for `antigravity`) | `SEVERALLY_CODEX_EFFORT` / `SEVERALLY_CLAUDE_EFFORT` / `SEVERALLY_OPENCODE_EFFORT` | Reasoning effort, translated per CLI: Codex `-c model_reasoning_effort=…`, Claude Code `--effort …`, OpenCode the model variant `provider/model#…`. A value the CLI or model does not support fails the consultation (e.g. glm-5.2 has `high`/`max` only). Antigravity takes the effort from the model name instead (`gemini-3.8-flash-low` / `-medium` / `-high`), so setting `effort` there fails with `spawn_error`. |
| `args` | array of strings | `[]` | – (config-only) | Extra CLI arguments appended to the consultant's command line, e.g. `["--disallowedTools", "WebFetch"]`. `--effort` is refused here; use the `effort` key. Any flag severally already sets for this consultant (and its aliases), or that would undo its isolation, is refused: the consultation fails with `spawn_error` naming the flag, before the CLI starts. |
| `max_budget_usd` | number, 0.05–20 | `10` | `SEVERALLY_CLAUDE_MAX_BUDGET_USD` | `claude-code` only: the spending cap passed to the Claude Code consultant for one consultation. |
| `env` | object of strings | `{}` | – (config-only) | Extra environment variables for the consultant, e.g. `{"HTTPS_PROXY": "http://proxy:3128"}`. Applied on top of the server's own environment. A variable severally strips or sets for isolation (session markers, `SEVERALLY_*`, another vendor's credentials, the sandbox's `HOME`/`XDG_*`, `OPENCODE_*` for OpenCode, …) is refused the same way. |

Current built-in `default_model` per target: `codex` → `gpt-6-astra`, `claude-code` → `claude-opus-5-5`,
`antigravity` → `gemini-3.8-flash-high`, `opencode` → `zai-coding-plan/glm-5.3`.

`args` and `env` are the operator's, like `bin`: no request can set them, and the refusals above guard
against undoing the isolation by accident, not against a deliberate wrapper. They are fixed per target, not
per consultation.

## Server-wide keys

Under `server`. Each one can also be set by its environment variable, which wins over the file. Use the file:
Codex and OpenCode do not pass your shell's environment to the MCP server, so an exported variable reaches the
server only from Claude Code and Antigravity.

| Key | Default | Range | Overriding env var | What it does |
|---|---|---|---|---|
| `max_rounds` | 5 (1 initial + 4 follow-ups) | 1–20 | `SEVERALLY_MAX_ROUNDS` | Rounds per consultation chain, the first one included. |
| `max_concurrent` | 9 | 1–9 | `SEVERALLY_MAX_CONCURRENT` | Consultations running at once; a request that would go over it is refused. A "consult everyone" fan-out takes four. |
| `max_jobs_retained` | 200 | 20–2000 | `SEVERALLY_MAX_JOBS_RETAINED` | Jobs the running server keeps in memory; older finished ones are dropped from memory, never from the history on disk. |
| `max_wait_ms` | 45000 | 0–600000 | `SEVERALLY_MAX_WAIT_MS` | Longest `wait_ms` a single `consult_get` may block for. Keep it under your client's tool-call timeout. |
| `timeout_ms` | 600000 | 1000–1800000 | `SEVERALLY_TIMEOUT_MS` | Wall-clock budget per consultation, for every consultant without its own `timeout_ms`. |
| `kill_grace_ms` | 5000 | 500–60000 | `SEVERALLY_KILL_GRACE_MS` | Time between asking a stopped consultant to exit and killing it. |

A value outside the range is clamped to it.

## Environment only

These decide where the config file and the credentials are, so they cannot live in the file, or name the
enabled set as a whole:

| Env var | Default | What it does |
|---|---|---|
| `SEVERALLY_HOME` | `~/.severally` | Where history and the config file live. |
| `SEVERALLY_CONFIG` | `~/.severally/config.json` / `.jsonc`, whichever exists | The config file itself. |
| `SEVERALLY_AGY_CRED_HOME` | `$HOME` | Where the Antigravity consultant's real credentials are read from. |
| `SEVERALLY_OPENCODE_CRED_HOME` | `$HOME` | Same for OpenCode. |
| `SEVERALLY_TARGETS` | – (auto-detected) | Comma-separated target ids: the whole enabled set at once, overriding every `enabled`. |

## Example

[config.example.json](config.example.json) exercises every per-target key above at least once. It is not a
recommended starting configuration — most operators need only one or two of these overrides — it exists so
every key has a working example to copy from.
