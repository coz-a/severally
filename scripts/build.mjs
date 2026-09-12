#!/usr/bin/env node
// Bundles the server into one dependency-free file and generates the per-host
// skills from a single template.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'plugins', 'peer-consult', 'skills');

// `en`/`jp` are the everyday name a user would actually type when asking for
// this peer by alias ("ask GPT", "gptと相談して") -- English keeps the
// acronym capitalised, casual Japanese usually doesn't.
const PEERS = {
  codex: {
    label: 'Codex CLI',
    short: 'Codex',
    reach: 'the question is about implementation detail, tricky code, or a decision where a different training lineage helps',
    en: 'GPT',
    jp: 'gpt',
    jpVerb: 'と相談して',
  },
  'claude-code': {
    label: 'Claude Code CLI',
    short: 'Claude Code',
    reach: 'you want a careful reading of a design or a long brief, or the decision hinges on trade-offs rather than a single fact',
    en: 'Claude',
    jp: 'Claude',
    jpVerb: 'に聞いて',
  },
  antigravity: {
    label: 'Antigravity CLI (Gemini)',
    short: 'Antigravity',
    reach: 'you want a third reading, or the question needs current web material',
    en: 'Gemini',
    jp: 'Gemini',
    jpVerb: 'と相談して',
  },
};

const HOSTS = [
  { dir: 'claude', self: 'claude-code' },
  { dir: 'codex', self: 'codex' },
  { dir: 'antigravity', self: 'antigravity' },
];

// Asking for *everyone* names no peer, so these phrases cannot be generated
// per peer like the ones below. Each host resolves them to its own two peers.
const EVERYONE_TRIGGERS = [
  '"みんなで相談して"',
  '"みんなに聞いて"',
  '"全員に聞いて"',
  '"両方に相談して"',
  '"ask everyone"',
  '"ask both"',
];

// All four everyday-alias shapes for one peer: "ask X", "get X to review
// this", the natural Japanese "XにVERBして" form, and "Xにレビューしてもらって".
function triggersFor(peerId) {
  const p = PEERS[peerId];
  return [
    `"ask ${p.en}"`,
    `"get ${p.en} to review this"`,
    `"${p.jp}${p.jpVerb}"`,
    `"${p.jp}にレビューしてもらって"`,
  ];
}

// Pure: reads the template and returns the rendered SKILL.md text for each
// host, keyed by host directory. Writes nothing, so it is safe to call from
// a test without mutating the working tree.
export function renderSkills() {
  const tmpl = fs.readFileSync(path.join(skillsDir, '_template', 'SKILL.md.tmpl'), 'utf8');
  const rendered = {};
  for (const host of HOSTS) {
    const peers = Object.keys(PEERS).filter((id) => id !== host.self);
    const table = [
      '| target | Consultant | Reach for it when |',
      '|---|---|---|',
      ...peers.map((id) => `| \`${id}\` | ${PEERS[id].label} | ${PEERS[id].reach} |`),
    ].join('\n');
    // Every consultant can read files; what keeps the answer brief-only is
    // that the child starts in an empty working directory and is never told
    // where the repository is. Codex additionally keeps a read-only shell, so
    // "they cannot run commands" would be false about it.
    const codexCaveat = peers.includes('codex')
      ? ' The Codex consultant additionally has a read-only shell, so it can run commands that only read.'
      : '';
    const executionCaveat = '\n\nOne caveat on that list: a consultant can read local files. Its writes and its'
      + '\nnetwork access are blocked, and it starts in an empty working directory without being told where'
      + '\nyour repository is, so in practice it answers from the brief.' + codexCaveat;
    const text = tmpl
      .replaceAll('{{EXECUTION_CAVEAT}}', executionCaveat)
      .replaceAll('{{DESCRIPTION_PEERS}}', peers.map((id) => PEERS[id].short).join(' or '))
      .replaceAll('{{TRIGGERS}}', [...peers.flatMap(triggersFor), ...EVERYONE_TRIGGERS].join(', '))
      .replaceAll('{{PEER_TABLE}}', table)
      .replaceAll('{{DEFAULT_TARGET}}', peers[0])
      // The other peer, used by the fan-out example so each host's skill shows
      // a `targets` array of two consultants that are not itself.
      .replaceAll('{{SECOND_TARGET}}', peers[1])
      .replaceAll('{{SELF_TARGET}}', host.self);
    rendered[host.dir] = text;
  }
  return rendered;
}

// Thin writer: renders and writes each host's SKILL.md. Stays silent --
// logging belongs to the CLI entry point below, not to code that may be
// imported (e.g. by a test).
export function generateSkills() {
  const rendered = renderSkills();
  for (const host of HOSTS) {
    const out = path.join(skillsDir, host.dir, 'peer-consult');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'SKILL.md'), rendered[host.dir]);
  }
}

export async function bundle() {
  const outfile = path.join(root, 'plugins', 'peer-consult', 'dist', 'peer-consult-mcp.mjs');
  const result = await build({
    entryPoints: [path.join(root, 'bin', 'peer-consult-mcp.mjs')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: false, // keep it auditable: this file runs with the user's credentials
    logLevel: 'info',
    metafile: true,
  });
  fs.chmodSync(outfile, 0o755);
  const bytes = fs.statSync(outfile).size;
  const inputs = Object.keys(result.metafile.outputs[path.relative(process.cwd(), outfile)]?.inputs ?? {}).length;
  console.log(`\nbundled ${inputs} modules -> ${outfile} (${(bytes / 1024).toFixed(0)} KB)`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  generateSkills();
  for (const host of HOSTS) {
    console.log(`skill -> ${path.relative(root, path.join(skillsDir, host.dir, 'peer-consult', 'SKILL.md'))}`);
  }
  if (!process.argv.includes('--skills-only')) await bundle();
}
