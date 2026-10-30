# Configuration reference

`~/.severally/config.json` (or `config.jsonc`, or a path set by `SEVERALLY_CONFIG`) is the one file an
operator edits to change severally's behavior on a machine — which consultants exist, which CLI and model
each one runs on, and so on. Generate a starting point for the current machine with:

```bash
npm run init-config            # writes ~/.severally/config.json (never overwrites an existing one)
```

or copy [config.example.json](config.example.json) by hand and trim it to the overrides you actually need —
you do not have to set every key.

The file is read once at server startup, so restart the MCP client after changing it. On Windows, write an
executable path with forward slashes (`"bin": "C:/Tools/claude.exe"`) or escaped backslashes
(`"bin": "C:\\Tools\\claude.exe"`). Where a key also has an
environment variable (a CLI's `bin`, the server-wide limits), the variable wins over the file.

**A mistake is kept to where it is.** A mistake inside one consultant (an unknown key, a missing `cli` or
`model`, `effort` on an Antigravity consultant) takes only that consultant out of use; asking for it is refused
with `target_unavailable` and the reason. A mistake inside `clis.<cli>` turns that CLI off. Everything else keeps
working, and each mistake is written to stderr at startup and listed under `config_mistakes` in the limits a
refused request returns. A mistake in the file as a whole (a syntax error, an unknown top-level key, `clis`,
`consultants` or `ranking` of the wrong shape) still refuses every `consult_start` with `config_invalid`. None of
them falls back to defaults, because that would quietly re-enable a CLI you turned off.

**Comments are fine.** `//` and `/* */` comments and trailing commas are stripped before parsing, in both a
`.json` and a `.jsonc` file — use whichever extension your editor is happy with (if it flags comments in
`.json` as an error, name the file `config.jsonc`; both are read the same way).

## Shape

```json
{
  "server": { },
  "clis": {
    "<codex | claude-code | antigravity | opencode>": { }
  },
  "consultants": {
    "<name>": { "cli": "<codex | claude-code | antigravity | opencode>", "model": "<model id>" }
  },
  "ranking": ["<name or model words>", "..."]
}
```

A **consultant** is one CLI running one model, under a name you choose. Several can share a CLI: GLM and
DeepSeek both on OpenCode, or two GPT models on Codex, each asked as a consultant of its own. `clis` says how
to launch each CLI and whether it is on; `consultants` says who can be asked. All four keys are optional, and
the server reads no other top-level key.

Without `consultants`, the server makes one consultant per CLI, named after the CLI, on its built-in model:
`codex` → `gpt-6-astra`, `claude-code` → `claude-opus-5-5`, `antigravity` → `gemini-4-argon-high`,
`opencode` → `zai-coding-plan/glm-5.3`. With `consultants`, those are the whole list: the built-in ones are
not added.

## `clis.<cli>`

| Key | Type | Default | Overriding env var | What it does |
|---|---|---|---|---|
| `enabled` | boolean | `true` if the CLI is found on `PATH` | – | Turns a CLI, and every consultant on it, off without uninstalling it. |
| `note` | string | – | – | Shown to the caller instead of a bare refusal when the CLI is off — e.g. `"rate-limited until 15:00"`. |
| `bin` | string | the CLI's usual command name (`codex`, `claude`, `agy`, `opencode`) | `SEVERALLY_CODEX_BIN` / `SEVERALLY_CLAUDE_BIN` / `SEVERALLY_AGY_BIN` / `SEVERALLY_OPENCODE_BIN` | Command name on `PATH`, or an absolute (or `~`-relative) path, when the executable isn't the default one. |
| `args` | array of strings | `[]` | – | Extra CLI arguments appended to every consultant's command line on this CLI, e.g. `["--disallowedTools", "WebFetch"]`. `--effort` is refused here; use the consultant's `effort`. Any flag severally already sets for this CLI (and its aliases), or that would undo its isolation, is refused: the consultation fails with `spawn_error` naming the flag, before the CLI starts. |
| `env` | object of strings | `{}` | – | Extra environment variables for the consultant, e.g. `{"HTTPS_PROXY": "http://proxy:3128"}`. Applied on top of the server's own environment, after other services' credentials have been dropped from it (a name set here is passed as it is). A variable severally strips or sets for isolation (session markers, `SEVERALLY_*`, another vendor's credentials, the sandbox's `HOME`/`XDG_*`, `OPENCODE_*` for OpenCode, …) is refused the same way. |
| `provider` | object | – | – | OpenCode only. Provider definitions in the shape of `opencode.json`'s `provider` key, copied into the consultant's sandbox config — see below. Nothing else from your own `opencode.json` is carried over. |

`args` and `env` are the operator's, like `bin`: no request can set them, and the refusals above guard
against undoing the isolation by accident, not against a deliberate wrapper.

## `consultants.<name>`

A name is lower-case letters, digits, `.` and `-`, at most 64 characters; `all` is reserved (it means "everyone").

| Key | Type | Default | What it does |
|---|---|---|---|
| `cli` | `codex` / `claude-code` / `antigravity` / `opencode` | required | The CLI this consultant runs on. |
| `model` | string | required | The model it runs. Two consultants with the same `cli` and `model` are refused: asking one model twice adds no independence. |
| `effort` | string | `high` | Reasoning effort, translated per CLI: Codex `-c model_reasoning_effort=…`, Claude Code `--effort …`, OpenCode the model variant `provider/model#…`. A value the CLI or model does not support fails the consultation as `model_unavailable` (e.g. glm-5.2 has `high`/`max` only). For OpenCode, a model written with its own `#variant` keeps it, and one written with a bare trailing `#` (`opencode/nemotron-3-ultra-free#`) runs with no variant, for models that have none. Not allowed on an Antigravity consultant: agy takes the effort from the model name (`gemini-3.8-flash-low` / `-medium` / `-high`). |
| `timeout_ms` | number, 1000–7200000 | `server.timeout_ms` | This consultant's own wall-clock budget, for the one that reliably needs longer or shorter than the rest. |
| `max_budget_usd` | number, 0.05–20 | `10` | Claude Code consultants only: the spending cap for one consultation. |
| `fallback_model` | string | – | A model on the same CLI to run instead when `model`'s account quota is used up (`usage_limit`). The consultation is run again once, inside the same time budget, and the answer says that the fallback gave it; `model` on the result is the fallback, and the switch is listed under `retries`. If the fallback fails too, that failure is reported. Must differ from `model`. |
| `vendor` | string | from the model name | The lineage, for the same-lineage note on an answer. Read from the model name (`gpt` → openai, `claude` → anthropic, `gemini` → google, `glm` → zai, `deepseek` → deepseek, `nemotron` → nvidia); set it for a model the name does not place. |
| `enabled` | boolean | `true` | Turns this one consultant off, leaving the others on its CLI. |
| `note` | string | – | Why it is off, as for `clis`. |

### API keys and other model families, through OpenCode

If your existing CLI consultants are enough, no changes are needed. To add an OpenCode model:

1. Authenticate the provider with `opencode auth login`, then run `opencode models` and copy an exact
   `provider/model` entry. Enter API keys in OpenCode's login flow, not severally's configuration. For a local
   model, start its server instead; the provider configuration below points severally at that server.
2. Add a consultant to `~/.severally/config.jsonc` (merge with your existing config). For a provider OpenCode
   already knows, only the consultant is needed. For example, if `opencode models` lists this model:

   ```jsonc
   {
     "consultants": {
       "qwen": { "cli": "opencode", "model": "openrouter/qwen/qwen3.7-plus#", "vendor": "alibaba" }
     }
   }
   ```

   The trailing `#` selects no effort variant. For a custom compatible API or a local model, use the provider
   example below as well; listing a model in your own OpenCode config does not copy its provider settings.
3. Restart the client and run `npx -y severally-mcp@2.12.0 status`. Confirm the new consultant is available and
   OpenCode is logged in. This does not send a prompt or prove the model exists or has quota.
4. Ask “Ask qwen whether a 30-second cache meets a 60-second freshness limit.” An `auth` failure calls for
   checking provider credentials; `model_unavailable` calls for checking the exact model and provider config.
   A `usage_limit` is a quota failure, not advice. Fix that cause before retrying.

The API and local routes have different validation limits: OpenRouter read an exposed file and returned the
required answer shape in the dated checks below; the tested Ollama model answered from the brief but did not
read the exposed file. These checks do not establish that every listed model can review code reliably.

OpenCode is the way to consult other model families. A `provider/model` listed by `opencode models` can be
configured as a consultant, but listing it does not prove your provider offers it, has quota, or can return the
required response. Checked on 2026-10-17 with opencode 2.0.24: `opencode/deepseek-v4.1-flash-free` (DeepSeek) and
`opencode/nemotron-3-ultra-free#` (NVIDIA Nemotron, which has no effort variant) both answered as consultants,
under the same boundary as GLM. The consultant uses the providers your own OpenCode already has credentials
for; provider settings in your own `opencode.json` (a custom base URL, for example) are not carried into its
sandbox.

A provider OpenCode does not know out of the box, such as a local model behind an OpenAI-compatible server
(ollama, LM Studio, vLLM) or another vendor's compatible API, goes under `clis.opencode.provider`, written as in
`opencode.json`. It is copied into the sandbox config as is; the sandbox's permissions, empty MCP list and the
rest stay severally's:

```jsonc
{
  "clis": {
    "opencode": {
      "provider": {
        "ollama": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "http://127.0.0.1:11434/v1" },
          "models": { "qwen3:32b": {} }
        }
      }
    }
  },
  "consultants": {
    "glm": { "cli": "opencode", "model": "zai-coding-plan/glm-5.3" },
    // A trailing # runs the model with no effort variant; vendor places a model the name does not.
    "qwen": { "cli": "opencode", "model": "ollama/qwen3:32b#", "vendor": "alibaba" }
  }
}
```

A key for a hosted API goes in `options.apiKey` as `"{env:MY_API_KEY}"`, with `MY_API_KEY` set in
`clis.opencode.env`. Checked on 2026-10-17 with opencode 2.0.24 against a stub OpenAI-compatible server on
`127.0.0.1`: a consultant defined this way answered through the sandbox like any other. Checked again on
2026-10-18 against a real ollama 0.34.0 (in Docker) with the provider above: `ollama/qwen3:8b#` answered a review
in the required shape, and the sandbox check (`live-check --mode sandbox`) found the consultant launched with no
write or shell tool. Neither `qwen3:8b` nor `qwen3:4b` called its read tool on an exposed file, though, and
`qwen3:4b` did not keep to the answer's shape (`invalid_output`): a small local model is in practice a
consultant that answers from the brief alone.

OpenRouter works the same way. It is an OpenAI-compatible provider, and its key comes from the environment:

```jsonc
{
  "clis": {
    "opencode": {
      "provider": {
        "openrouter": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "https://openrouter.ai/api/v1", "apiKey": "{env:OPENROUTER_API_KEY}" },
          "models": { "qwen/qwen3.7-plus": {}, "moonshotai/kimi-k2.6": {} }
        }
      }
    }
  },
  "consultants": {
    "qwen": { "cli": "opencode", "model": "openrouter/qwen/qwen3.7-plus#", "vendor": "alibaba" },
    "kimi": { "cli": "opencode", "model": "openrouter/moonshotai/kimi-k2.6#", "vendor": "moonshot" }
  }
}
```

Set `OPENROUTER_API_KEY` in `clis.opencode.env`, or export it in the environment the severally server starts
from. Exporting works only when the lead is Claude Code or Antigravity (see [Server-wide keys](#server-wide-keys)),
but it keeps the key out of the config file: a variable named by an `{env:NAME}` in this provider config is
passed to the OpenCode consultant, while other services' credentials are still dropped.

The two named entries above use the same OpenCode CLI with different models. Replace the example model IDs with
IDs available to your provider and preserve any other consultants you want: an explicit `consultants` object
replaces the built-in list. A generic request for `opencode` may match both entries; name `qwen` or `kimi`
explicitly when the destination matters. Different sessions or model names alone do not establish independent
model lineages or prove that a provider served the model named in configuration.

Checked on 2026-10-18 with opencode 2.0.24, for both `qwen/qwen3.7-plus` and `moonshotai/kimi-k2.6`:
- Each read an exposed file (one `read` call) and quoted a word that only that file held.
- Each answered in the required shape.
- `live-check --mode sandbox` found each consultant launched with no write or shell tool.
- The key did not appear in severally's history or logs.

The seven consultations cost about 0.05 USD in all.

## How a name reaches a consultant

A request names a consultant by whatever the user called it, and the server resolves it in this order:

1. a consultant's own name (`"sol"`);
2. a CLI (`codex`, `claude-code`, `antigravity` or `agy`, `opencode`): the consultants on that CLI;
3. a vendor (`openai` or `chatgpt`, `anthropic`, `google`): that vendor's consultants, on any CLI;
4. otherwise, whole words of a model id, after its provider prefix: `glm` reaches `zai-coding-plan/glm-5.3`,
   `claude opus` reaches `claude-opus-5-5`, `glm-5.2` reaches `…/glm-5.2`. `g` reaches nothing: it is not a word
   of any of them.

`targets: ["all"]` asks every consultant that is available.

## `ranking`

When a name fits more than one consultant, these rules are tried in order, and the first that leaves one wins:

1. **`ranking`**, higher first. Each entry is a consultant's name or model words, like the names above. A
   consultant matching an earlier entry beats one matching a later entry or none. An entry that matches no
   consultant is allowed and does nothing.
2. **The built-in tiers**: `opus` > `sonnet` > `haiku`; `ultra` > `pro` > `flash` > `lite`; and the effort
   words in a model name, `max` > `xhigh` > `high` > `medium` > `low`. They apply only when every candidate
   carries a word from the same list.
3. **The version**, only between models with the same stem (the words before the version): `glm-5.3` beats
   `glm-5.2`, `gpt-6.1-sol` beats `gpt-6-astra`.

The tier comes before the version: `claude-opus-5-5` beats `claude-sonnet-6`. Put `"sonnet"` first in `ranking`
if you want it the other way round. When nothing separates the candidates (`glm-5.3` against DeepSeek, two
models with the same version), the request is refused as `target_ambiguous` and lists them, rather than
picking one.

## Server-wide keys

Under `server`. Each one can also be set by its environment variable, which wins over the file. Use the file:
Codex and OpenCode do not pass your shell's environment to the MCP server, so an exported variable reaches the
server only from Claude Code and Antigravity.

| Key | Default | Range | Overriding env var | What it does |
|---|---|---|---|---|
| `max_rounds` | 5 (1 initial + 4 follow-ups) | 1–20 | `SEVERALLY_MAX_ROUNDS` | Rounds per consultation chain, the first one included. |
| `max_concurrent` | 9 | 1–9 | `SEVERALLY_MAX_CONCURRENT` | Consultations running at once, counted across every severally process that shares this home (one runs per client session); a request that would go over it is refused. A "consult everyone" fan-out takes one per consultant, and is refused if that is over the cap. |
| `max_jobs_retained` | 200 | 20–2000 | `SEVERALLY_MAX_JOBS_RETAINED` | Jobs the running server keeps in memory; older finished ones are dropped from memory, never from the history on disk. |
| `max_wait_ms` | 45000 | 0–600000 | `SEVERALLY_MAX_WAIT_MS` | Longest `wait_ms` a single `consult_get` may block for. Keep it under your client's tool-call timeout. A `consult_get` with no `wait_ms` waits for this long, or 45000 if this is higher, unless the environment variable is set: it belongs to one client's registration, so it also sets that client's default wait (and takes precedence over this key). The installer's registrations for Claude Code, Codex and OpenCode set the environment variable to 600000: Claude Code and OpenCode wait on a tool call far longer, and for Codex the installer raises its tool-call timeout to 660 s (in the plugin manifest, or as `tool_timeout_sec` in `config.toml` for a `--manual` registration). Antigravity stops a tool call at 3 minutes whatever the progress, so the installer registers it with 165000. While it waits, `consult_get` sends a progress notification every 15 s when the client asks for them, and stops waiting if the client cancels the call. |
| `timeout_ms` | 1800000 | 1000–7200000 | `SEVERALLY_TIMEOUT_MS` | Wall-clock budget per consultation, for every consultant without its own `timeout_ms`. |
| `kill_grace_ms` | 5000 | 500–60000 | `SEVERALLY_KILL_GRACE_MS` | Time between asking a stopped consultant to exit and killing it; also how long the server waits for running consultants when it shuts down. |
| `max_auto_retries` | 2 | 0–3 | `SEVERALLY_MAX_AUTO_RETRIES` | How many times a consultation that failed with `rate_limited` or `cli_error` is run again automatically, inside its original time budget. `0` turns it off. |
| `network` | `"on"` | `"on"` or `"off"` | `SEVERALLY_NETWORK` | `"off"` takes web search and browsing away from every consultation, whatever the request's own `network` says; `"on"` leaves it to each request. Unlike the other keys, `"off"` from either the file or the environment wins, so one cannot reopen what the other closed. Any other value is a config mistake that refuses every consultation. |
| `retry_backoff_ms` | 5000 | 0–60000 | `SEVERALLY_RETRY_BACKOFF_MS` | Wait before the first automatic re-run; each later one waits three times longer. |

A number outside its range is clamped to it.

## Environment only

These decide where the config file and the credentials are, so they cannot live in the file:

| Env var | Default | What it does |
|---|---|---|
| `SEVERALLY_HOME` | `~/.severally` | Where history and the config file live. |
| `SEVERALLY_CONFIG` | `~/.severally/config.json` / `.jsonc`, whichever exists | The config file itself. |
| `SEVERALLY_AGY_CRED_HOME` | `$HOME` | Where the Antigravity consultant's real credentials are read from. |
| `SEVERALLY_OPENCODE_CRED_HOME` | `$HOME` | Same for OpenCode. |

Known absolute credential-location variables (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, OpenCode's `XDG_*` roots,
`GOOGLE_APPLICATION_CREDENTIALS`, and protected subpaths under `HOME`/Windows `USERPROFILE`) are included in
read-deny roots, as are the configured Antigravity/OpenCode credential homes and the actual severally config
file. This does not cover arbitrary paths passed through CLI/plugin arguments, relative locations or new
symlink aliases. Codex also has file-replacement and executable-directory limitations; see
[the protection details](docs/how-it-works.md#how-a-consultant-is-kept-to-reading).

## Example

[config.example.json](config.example.json) exercises every `clis` and `consultants` key above at least once. It is not a
recommended starting configuration — most operators need only one or two of these overrides — it exists so
every key has a working example to copy from.
