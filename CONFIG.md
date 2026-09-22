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
  "targets": {
    "<codex | claude-code | antigravity | opencode>": { }
  }
}
```

`targets` is the only top-level key the server reads. Every setting lives under one of the four target ids.

## Per-target keys

| Key | Type | Default | Overriding env var | What it does |
|---|---|---|---|---|
| `enabled` | boolean | `true` if the CLI is found on `PATH` | `SEVERALLY_TARGETS` (comma-separated list; names the whole enabled set at once) | Turns a consultant on/off without uninstalling it. |
| `note` | string | – | – (config-only) | Shown to the caller instead of a bare refusal when the target is unavailable — e.g. `"rate-limited until 15:00"`. |
| `bin` | string | the CLI's usual command name (`codex`, `claude`, `agy`, `opencode`) | `SEVERALLY_CODEX_BIN` / `SEVERALLY_CLAUDE_BIN` / `SEVERALLY_AGY_BIN` / `SEVERALLY_OPENCODE_BIN` | Command name on `PATH`, or an absolute (or `~`-relative) path, when the executable isn't the default one. |
| `default_model` | string | see table below | `SEVERALLY_CODEX_MODEL` / `SEVERALLY_CLAUDE_MODEL` / `SEVERALLY_AGY_MODEL` / `SEVERALLY_OPENCODE_MODEL` | The model a consultation runs when the caller doesn't name one. Always implicitly allowed, even if left out of `allowed_models`. |
| `allowed_models` | array of strings | `[default_model]` | `SEVERALLY_CODEX_ALLOWED_MODELS` / `SEVERALLY_CLAUDE_ALLOWED_MODELS` / `SEVERALLY_AGY_ALLOWED_MODELS` / `SEVERALLY_OPENCODE_ALLOWED_MODELS` (comma-separated) | Models a caller may request by name, e.g. `target: "codex:<model>"`. A name outside this list is refused before the consultant starts. |
| `timeout_ms` | number, 1000–1800000 | the shared timeout (`SEVERALLY_TIMEOUT_MS`, 600000 by default) | `SEVERALLY_CODEX_TIMEOUT_MS` / `SEVERALLY_CLAUDE_TIMEOUT_MS` / `SEVERALLY_AGY_TIMEOUT_MS` / `SEVERALLY_OPENCODE_TIMEOUT_MS` | Per-consultant wall-clock budget, for the one target that reliably needs longer (or shorter) than the rest — e.g. Gemini on an involved request. |

Current built-in `default_model` per target: `codex` → `gpt-6-astra`, `claude-code` → `claude-fable-5-1`,
`antigravity` → `gemini-3.8-flash-high`, `opencode` → `zai-coding-plan/glm-5.3`.

## Not configurable in `config.json`

These are server-wide, not per-target, so they are environment-only — there is no config-file key for them:

| Env var | Default | Range |
|---|---|---|
| `SEVERALLY_MAX_ROUNDS` | 5 (1 initial + 4 follow-ups) | 1–20 |
| `SEVERALLY_MAX_CONCURRENT` | 4 | 1–4 |
| `SEVERALLY_MAX_JOBS_RETAINED` | 200 | 20–2000 |
| `SEVERALLY_CLAUDE_MAX_BUDGET_USD` | 10 | 0.05–20 |
| `SEVERALLY_MAX_WAIT_MS` | 45000 | 0–600000 |
| `SEVERALLY_KILL_GRACE_MS` | 5000 | 500–60000 |
| `SEVERALLY_HOME` | `~/.severally` | – |
| `SEVERALLY_AGY_CRED_HOME` | `$HOME` | – |
| `SEVERALLY_OPENCODE_CRED_HOME` | `$HOME` | – |
| `SEVERALLY_TARGETS` | – (auto-detected) | comma-separated target ids |
| `SEVERALLY_CONFIG` | `~/.severally/config.json` / `.jsonc`, whichever exists | any path |

## Example

[config.example.json](config.example.json) exercises every per-target key above at least once. It is not a
recommended starting configuration — most operators need only one or two of these overrides — it exists so
every key has a working example to copy from.
