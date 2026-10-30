# severally

Ask coding agents for independent opinions, returned separately. The lead checks the grounds and records its decision.

## Install

You need Node.js 22 or newer and at least one installed, logged-in consultant CLI. For Claude Code, run in its chat:

```text
/plugin marketplace add coz-a/severally
/plugin install severally@severally
```

Restart Claude Code. For the installer, other clients and platform limits, see the
[installation guide](https://github.com/coz-a/severally/blob/main/docs/install.md).

Check which consultant CLIs are detected with `npx -y severally-mcp@2.12.0 status`. Detection does not
guarantee that a CLI is logged in or that a consultation will succeed. For updating and removing the plugin,
see [updating](https://github.com/coz-a/severally/blob/main/docs/install.md#updating) and
[uninstalling](https://github.com/coz-a/severally/blob/main/docs/install.md#uninstall).

## Usage

In your restarted agent's chat, ask:

```text
Ask Codex: Our read-only public API gets 100 requests per minute.
Updates may appear 60 seconds late. Is a 30-second cache reasonable?
```

Use an installed consultant's name. The lead reports each consultant's recommendation, what it checked and
what remains unverified. Ask “What changes if updates must appear within five seconds?” to continue in a
fresh CLI session with saved context and checks. Asking everyone spends quota per consultant.
The brief, exposed files and anything the consultant reads go to its model; read restrictions have limits.
See the [English guide](https://github.com/coz-a/severally/blob/main/README.md) or
[日本語ガイド](https://github.com/coz-a/severally/blob/main/README.ja.md) for the report example and protection limits.

These links use GitHub `main` so they work when this plugin is distributed separately. They describe the latest
source and may differ from your installed version; use a matching release tag for version-specific instructions.

## Contributing

This directory contains the bundled MCP server and generated host-specific skills. In a source checkout,
edit the source and skill templates at the repository root, then run `npm run build`.
See [contribution and test instructions](https://github.com/coz-a/severally/blob/main/README.md#contributing).
Report issues or propose changes in the [repository](https://github.com/coz-a/severally).

## License

[Apache-2.0](LICENSE) © 2026 coz.a
