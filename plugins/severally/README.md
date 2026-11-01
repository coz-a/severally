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
[installation guide](https://github.com/coz-a/severally/blob/v2.14.1/docs/install.md).

Check which consultant CLIs are detected with `npx -y severally-mcp@2.14.1 status`. Detection does not
guarantee that a CLI is logged in or that a consultation will succeed. For updating and removing the plugin,
see [updating](https://github.com/coz-a/severally/blob/v2.14.1/docs/install.md#updating) and
[uninstalling](https://github.com/coz-a/severally/blob/v2.14.1/docs/install.md#uninstall).

## Usage

Run `npx -y severally-mcp@2.14.1 status` to find a detected consultant. In your restarted agent's chat, ask
using its name (Codex below is an example):

```text
Ask Codex: Our public API must return data no more than 60 seconds old.
The upstream data may already be 40 seconds old when fetched; assume zero fetch time.
Is a fixed 30-second TTL reasonable? State the conditions and the smallest useful check.
```

Use an installed consultant's name. The lead reports each consultant's recommendation, what it checked and
what remains unverified. Ask “What changes if updates must appear within five seconds?” to continue in a
fresh CLI session with saved context and checks. Asking everyone spends quota per consultant.
For example: "Use TTL <= 20 seconds under these assumptions. Codex (gpt-6.1-sol, f1) identified the age budget.
I checked 40 + 29 = 69 seconds and rejected TTL30; refreshing when elapsed >= 20 seconds remains untested."
The model, point IDs and check results depend on the run.
Ask "Stop the current consultation" to request termination, or "Check the answers that have arrived first"
while others run. Windows uses a launch Job; see the [requirements and stop limits](https://github.com/coz-a/severally/blob/v2.14.1/docs/how-it-works.md#records).

The brief, exposed files and anything the consultant reads go to its model; read restrictions have limits.
See the [English guide](https://github.com/coz-a/severally/blob/v2.14.1/README.md) or
[日本語ガイド](https://github.com/coz-a/severally/blob/v2.14.1/README.ja.md) for the report example and protection limits.

Guide links are pinned to this package's release tag by the build, so they also work when the plugin is
distributed separately. For unreleased source changes, use the documents in the same source checkout.

## Contributing

This directory contains the bundled MCP server and generated host-specific skills. In a source checkout,
edit the source and skill templates at the repository root, then run `npm run build`.
See [contribution and test instructions](https://github.com/coz-a/severally/blob/v2.14.1/README.md#contributing).
Report issues or propose changes in the [repository](https://github.com/coz-a/severally).

## License

[Apache-2.0](LICENSE) © 2026 coz.a
