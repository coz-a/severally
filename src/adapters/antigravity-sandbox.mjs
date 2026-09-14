// Isolation for the Antigravity CLI.
//
// agy has no flag equivalent to codex --ignore-user-config or claude
// --restricted --strict-mcp-config: everything (MCP servers, hooks, skills,
// plugins, permissions, conversation history) is read from ~/.gemini. So the
// isolation is built by handing the child a synthesised HOME that contains
// nothing but a linked credential and two files we wrote ourselves:
//
//   .gemini/config/mcp_config.json      {}  -> zero MCP servers = recursion barrier
//   .gemini/antigravity-cli/settings.json   -> deny writes/commands/mcp, allow read_url
//
// Anything not in that tree cannot be inherited: no hooks.json, no skills/,
// no plugins, no projects/ overrides. Conversation state is written inside the
// tree and deleted with it, which is what --ephemeral gives us on Codex.

import fs from 'node:fs';
import path from 'node:path';
import { credentialsHome } from '../policy.mjs';

// Verified against agy 1.1.28: precedence is Deny > Ask > Allow, and headless
// mode auto-denies anything that would need a prompt. read_url must be allowed
// explicitly or the consultant can search but never open a page; search_web
// needs no rule. Every consultant receives its brief on stdin, so file-system
// reads are neither needed nor wanted.
// read_file is allowed, not denied: the three consultants have to be equal
// readers. Codex's child is sandboxed read-only rather than execution-free, so
// it could always read the disk; leaving the other two unable to meant the same
// brief reached three differently-equipped readers. command(*) stays denied, so
// this child reads files without gaining a shell.
export const SANDBOX_ALLOW = Object.freeze(['read_url(*)', 'read_file(*)']);
export const SANDBOX_DENY = Object.freeze([
  'write_file(*)',
  'command(*)',
  'mcp(*)',
  'execute_url(*)',
  'unsandboxed(*)',
]);

const TOKEN_REL = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

/**
 * Build the synthesised HOME for one consultation.
 * @param {{workdir: string}} opts workdir is <jobdir>/work; the home is its sibling.
 */
export function prepareSandbox({ workdir }) {
  const root = path.join(path.dirname(workdir), 'home');
  const cliDir = path.join(root, '.gemini', 'antigravity-cli');
  const cfgDir = path.join(root, '.gemini', 'config');
  fs.mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);

  fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(
    path.join(cliDir, 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [...SANDBOX_ALLOW], deny: [...SANDBOX_DENY] } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const source = path.join(credentialsHome(), TOKEN_REL);
  const link = path.join(cliDir, 'antigravity-oauth-token');
  let credentials = 'missing';
  if (fs.existsSync(source)) {
    try {
      fs.symlinkSync(source, link);
      credentials = 'symlink';
    } catch {
      // Some filesystems refuse symlinks; a copy still authenticates, but a
      // token refreshed by the child would be discarded with the sandbox.
      fs.copyFileSync(source, link);
      fs.chmodSync(link, 0o600);
      credentials = 'copy';
    }
  }

  return {
    root,
    credentials,
    // The exact path searched, so a caller that has to report `credentials:
    // "missing"` can say where it looked instead of leaving the operator to
    // guess which HOME severally read.
    credentialsSource: source,
    env: { HOME: root },
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
