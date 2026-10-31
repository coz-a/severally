# severally

A plugin that lets your AI agent ask other coding agents for independent opinions, returned separately.

The lead checks each consultant's grounds, records its checks and decision, and carries those checks with the
current files into a follow-up.

## Install

You need Node.js 22 or newer and at least one installed, logged-in consultant CLI. For Claude Code, run in its chat:

```text
/plugin marketplace add coz-a/severally
/plugin install severally@severally
```

Restart Claude Code. For the installer, other clients and platform limits, see the
[installation guide](https://github.com/coz-a/severally/blob/v2.13.0/docs/install.md).

Check which consultant CLIs are detected with `npx -y severally-mcp@2.13.0 status`. Detection does not
guarantee that a CLI is logged in or that a consultation will succeed. For updating and removing the plugin,
see [updating](https://github.com/coz-a/severally/blob/v2.13.0/docs/install.md#updating) and
[uninstalling](https://github.com/coz-a/severally/blob/v2.13.0/docs/install.md#uninstall).

## Usage

In your restarted agent's chat, ask:

```text
Ask Codex: Our read-only public API gets 100 requests per minute.
Updates may appear 60 seconds late. Is a 30-second cache reasonable?
```

Use an installed consultant's name. The lead reports each consultant's recommendation, what it checked and
what remains unverified. Ask “What changes if updates must appear within five seconds?” to continue in a
fresh CLI session with saved context and checks. Asking everyone spends quota per consultant.
For example, the lead may report: "Codex suggests 30 seconds. I checked that the total delay stays within
60 seconds; behavior during concurrent updates is still unverified." The model and findings depend on the run.
Ask "Stop the current consultation" to cancel, or "Check the answers that have arrived first" while others run.

The brief, exposed files and anything the consultant reads go to its model; read restrictions have limits.
See the [English guide](https://github.com/coz-a/severally/blob/v2.13.0/README.md) or
[日本語ガイド](https://github.com/coz-a/severally/blob/v2.13.0/README.ja.md) for the report example and protection limits.

Guide links are pinned to this package's release tag by the build, so they also work when the plugin is
distributed separately. For unreleased source changes, use the documents in the same source checkout.

## Contributing

This directory contains the bundled MCP server and generated host-specific skills. In a source checkout,
edit the source and skill templates at the repository root, then run `npm run build`.
See [contribution and test instructions](https://github.com/coz-a/severally/blob/v2.13.0/README.md#contributing).
Report issues or propose changes in the [repository](https://github.com/coz-a/severally).

## License

[Apache-2.0](LICENSE) © 2026 coz.a
