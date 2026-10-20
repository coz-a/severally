#!/usr/bin/env node
// Bundles the server into one dependency-free file and generates the per-host
// skills from a single template.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'plugins', 'severally', 'skills');

// `en`/`jp` are the everyday name a user would actually type when asking for
// this peer by alias ("ask GPT", "gptと相談して") -- English keeps the
// acronym capitalised, casual Japanese usually doesn't.
/** @type {Record<string, { label: string, short: string, reach: string, en: string, jp: string, jpVerb: string }>} */
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
    reach:
      'you want a careful reading of a design or a long brief, or the decision hinges on trade-offs rather than a single fact',
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
  opencode: {
    label: 'OpenCode CLI (whichever models the operator set up: GLM, DeepSeek, ...)',
    short: 'OpenCode',
    reach:
      'you want another training lineage on the question (GLM by default; the operator may have set up others, such as DeepSeek), or a further reading when the first three stay neck and neck',
    en: 'GLM',
    jp: 'GLM',
    jpVerb: 'に聞いて',
  },
};

const HOSTS = [
  { dir: 'claude', self: 'claude-code' },
  { dir: 'codex', self: 'codex' },
  { dir: 'antigravity', self: 'antigravity' },
  { dir: 'opencode', self: 'opencode' },
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
/** @param {string} peerId */
function triggersFor(peerId) {
  const p = PEERS[peerId];
  return [`"ask ${p.en}"`, `"get ${p.en} to review this"`, `"${p.jp}${p.jpVerb}"`, `"${p.jp}にレビューしてもらって"`];
}

// Claude Code only: the tools that send nothing out run without a permission
// prompt during the turn the Skill is invoked in, so polling a consultation
// does not ask once per call. consult_start stays out -- it is the consent to
// send the brief to other vendors. Both names: the plugin install prefixes
// its server's tools, a manual `claude mcp add` does not. The grant lasts
// one turn and the Skill itself then needs approving once (checked
// 2026-10-18 with `claude -p --permission-mode default`).
const QUIET_TOOLS = ['consult_get', 'consult_list', 'consult_record', 'consult_export', 'consult_cancel'];
/** @param {string} text */
function withAllowedTools(text) {
  const names = QUIET_TOOLS.flatMap((t) => [`mcp__plugin_severally_severally__${t}`, `mcp__severally__${t}`]);
  // A one-line description is assumed; a folded one would swallow the new key.
  if (!/^description: [^>|].*$/m.test(text))
    throw new Error('SKILL.md template: expected a one-line description to put allowed-tools after');
  return text.replace(/^(description: .*)$/m, `$1\nallowed-tools: ${names.join(' ')}`);
}

// Pure: reads the templates and returns each host's rendered skill files
// (SKILL.md, and the reference.md it points to), keyed by host directory and
// then file name. Writes nothing, so it is safe to call from a test without
// mutating the working tree.
export function renderSkills() {
  /** @type {Record<string, Record<string, string>>} */
  const rendered = {};
  for (const host of HOSTS) rendered[host.dir] = {};
  for (const name of SKILL_FILES) {
    const texts = renderTemplate(`${name}.tmpl`);
    for (const host of HOSTS) rendered[host.dir][name] = texts[host.dir];
  }
  return rendered;
}

const SKILL_FILES = ['SKILL.md', 'reference.md'];

/** @param {string} file */
function renderTemplate(file) {
  const tmpl = fs.readFileSync(path.join(skillsDir, '_template', file), 'utf8');
  /** @type {Record<string, string>} */
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
    const executionCaveat =
      '\n\nOne caveat on that list: a consultant can read local files. Its writes are blocked,' +
      '\nits network reaches only web search and browsing (none with `network: "off"`), credential and history' +
      '\npaths are refused where its CLI allows, and by default it starts in an empty working directory without being' +
      '\ntold where your repository is, so it answers from the brief and from the files you hand it:' +
      '\n`context.expose_paths` (absolute paths) or `context.expose_diff` (a change in progress), which are' +
      '\ncopied read-only into its working directory.' +
      codexCaveat;
    const text = tmpl
      .replaceAll('{{EXECUTION_CAVEAT}}', executionCaveat)
      .replaceAll('{{DESCRIPTION_PEERS}}', peers.map((id) => PEERS[id].short).join(' or '))
      .replaceAll('{{TRIGGERS}}', [...peers.flatMap(triggersFor), ...EVERYONE_TRIGGERS].join(', '))
      .replaceAll('{{PEER_TABLE}}', table)
      .replaceAll('{{DEFAULT_TARGET}}', peers[0])
      // The second peer, for the fan-out example of two named consultants.
      .replaceAll('{{SECOND_TARGET}}', peers[1])
      .replaceAll('{{SELF_TARGET}}', host.self);
    rendered[host.dir] = host.self === 'claude-code' && file === 'SKILL.md.tmpl' ? withAllowedTools(text) : text;
  }
  return rendered;
}

// Thin writer: renders and writes each host's SKILL.md. Stays silent --
// logging belongs to the CLI entry point below, not to code that may be
// imported (e.g. by a test).
export function generateSkills() {
  const rendered = renderSkills();
  for (const host of HOSTS) {
    const out = path.join(skillsDir, host.dir, 'severally');
    fs.mkdirSync(out, { recursive: true });
    for (const name of SKILL_FILES) fs.writeFileSync(path.join(out, name), rendered[host.dir][name]);
  }
}

export async function bundle() {
  const outfile = path.join(root, 'plugins', 'severally', 'dist', 'severally-mcp.mjs');
  const result = await build({
    entryPoints: [path.join(root, 'bin', 'severally-mcp.mjs')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    target: 'node20',
    minify: false, // keep it auditable: this file runs with the user's credentials
    logLevel: 'info',
    metafile: true,
  });
  fs.chmodSync(outfile, 0o755);
  const bytes = fs.statSync(outfile).size;
  const outputKey = path.relative(process.cwd(), outfile).split(path.sep).join('/');
  const inputs = Object.keys(result.metafile.outputs[outputKey]?.inputs ?? {}).length;
  console.log(`\nbundled ${inputs} modules -> ${outfile} (${(bytes / 1024).toFixed(0)} KB)`);
  writeNotices(Object.keys(result.metafile.outputs[outputKey]?.inputs ?? {}), path.dirname(outfile));
}

/**
 * THIRD_PARTY_NOTICES beside the bundle: each package the bundle actually
 * contains, with its LICENSE file verbatim. esbuild's legalComments cannot do
 * this -- these packages state their licence only in the LICENSE file.
 * @param {string[]} inputs
 * @param {string} outDir
 */
function writeNotices(inputs, outDir) {
  const pkgDirs = new Set();
  for (const input of inputs) {
    const m = input
      .split('/')
      .join(path.sep)
      .match(/^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)/);
    if (m) pkgDirs.add(path.resolve(process.cwd(), m[1]));
  }
  const sections = [...pkgDirs]
    .map((dir) => {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      if (!file) throw new Error(`${meta.name} has no LICENSE file; add its notice by hand before bundling it`);
      const license = typeof meta.license === 'string' ? meta.license : 'see the licence text';
      // Apache-2.0 4(d): a NOTICE file travels with the work.
      const notice = fs.readdirSync(dir).find((f) => /^notice(\.|$)/i.test(f));
      const noticeText = notice ? `\n${fs.readFileSync(path.join(dir, notice), 'utf8').trim()}\n` : '';
      return `${meta.name}@${meta.version} (${license})\n\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n${noticeText}`;
    })
    .sort();
  const header = 'severally-mcp.mjs bundles the following packages. Their licences follow.\n';
  fs.writeFileSync(path.join(outDir, 'THIRD_PARTY_NOTICES'), [header, ...sections].join(`\n${'-'.repeat(72)}\n\n`));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, '..', 'LICENSE'));
  console.log(`notices for ${sections.length} packages -> ${path.join(outDir, 'THIRD_PARTY_NOTICES')}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  generateSkills();
  for (const host of HOSTS) {
    console.log(`skill -> ${path.relative(root, path.join(skillsDir, host.dir, 'severally', 'SKILL.md'))}`);
  }
  if (!process.argv.includes('--skills-only')) await bundle();
}
