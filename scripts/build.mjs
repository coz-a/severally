#!/usr/bin/env node
// Bundles the server into one dependency-free file and generates the per-host
// skills from a single template.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'plugins', 'peer-consult', 'skills');

const PEERS = {
  codex: { label: 'Codex CLI', short: 'Codex', reach: 'the question is about implementation detail, tricky code, or a decision where a different training lineage helps' },
  'claude-code': { label: 'Claude Code CLI', short: 'Claude Code', reach: 'you want a careful reading of a design or a long brief, or the decision hinges on trade-offs rather than a single fact' },
  antigravity: { label: 'Antigravity CLI (Gemini)', short: 'Antigravity', reach: 'you want a third reading, or the question needs current web material' },
};

const HOSTS = [
  { dir: 'claude', self: 'claude-code', triggers: ['"ask GPT"', '"ask Gemini"', '"gptと相談して"', '"Geminiと相談して"', '"Codexに聞いて"'] },
  { dir: 'codex', self: 'codex', triggers: ['"ask Claude"', '"ask Gemini"', '"Claudeに聞いて"', '"Geminiと相談して"', '"Claudeにレビューしてもらって"'] },
  { dir: 'antigravity', self: 'antigravity', triggers: ['"ask GPT"', '"ask Claude"', '"gptと相談して"', '"Claudeに聞いて"', '"Codexにレビューしてもらって"'] },
];

export function generateSkills() {
  const tmpl = fs.readFileSync(path.join(skillsDir, '_template', 'SKILL.md.tmpl'), 'utf8');
  for (const host of HOSTS) {
    const peers = Object.keys(PEERS).filter((id) => id !== host.self);
    const table = [
      '| target | Consultant | Reach for it when |',
      '|---|---|---|',
      ...peers.map((id) => `| \`${id}\` | ${PEERS[id].label} | ${PEERS[id].reach} |`),
    ].join('\n');
    const text = tmpl
      .replaceAll('{{DESCRIPTION_PEERS}}', peers.map((id) => PEERS[id].short).join(' or '))
      .replaceAll('{{TRIGGERS}}', host.triggers.join(', '))
      .replaceAll('{{SELF_LABEL}}', PEERS[host.self].short)
      .replaceAll('{{PEER_TABLE}}', table)
      .replaceAll('{{DEFAULT_TARGET}}', peers[0])
      .replaceAll('{{SELF_TARGET}}', host.self);
    const out = path.join(skillsDir, host.dir, 'peer-consult');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'SKILL.md'), text);
    console.log(`skill -> ${path.relative(root, path.join(out, 'SKILL.md'))}`);
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
  if (!process.argv.includes('--skills-only')) await bundle();
}
