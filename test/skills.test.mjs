import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { here } from './helpers.mjs';

const skillsDir = path.join(here, '..', 'plugins', 'peer-consult', 'skills');
const read = (host) => fs.readFileSync(path.join(skillsDir, host, 'peer-consult', 'SKILL.md'), 'utf8');

const HOSTS = {
  claude: { self: 'Claude Code', peers: ['Codex', 'Antigravity'] },
  codex: { self: 'Codex', peers: ['Claude Code', 'Antigravity'] },
  antigravity: { self: 'Antigravity', peers: ['Codex', 'Claude Code'] },
};

test('every host has a skill that names its two peers and not itself as the default', () => {
  for (const [host, { self, peers }] of Object.entries(HOSTS)) {
    const text = read(host);
    for (const peer of peers) assert.match(text, new RegExp(peer), `${host} skill must offer ${peer}`);
    assert.match(text.split('\n')[2], /^description:/, `${host} skill needs frontmatter description`);
    assert.ok(!new RegExp(`independent opinion, review or structured debate from ${self}`).test(text),
      `${host} skill must not advertise consulting itself`);
  }
});

test('the trigger phrases cover the vendor aliases in both languages', () => {
  for (const host of Object.keys(HOSTS)) {
    const description = read(host).split('\n').find((l) => l.startsWith('description:'));
    const expected = host === 'codex'
      ? ['Claudeに聞いて', 'Geminiと相談して', 'ask Claude', 'ask Gemini']
      : host === 'claude'
        ? ['gptと相談して', 'Geminiと相談して', 'ask GPT', 'ask Gemini']
        : ['gptと相談して', 'Claudeに聞いて', 'ask GPT', 'ask Claude'];
    for (const phrase of expected) {
      assert.ok(description.includes(phrase), `${host} description must contain ${phrase}`);
    }
    assert.ok(description.includes('セカンドオピニオン'));
  }
});

test('the generated skills are in sync with the template', async () => {
  const before = Object.fromEntries(Object.keys(HOSTS).map((h) => [h, read(h)]));
  const { generateSkills } = await import('../scripts/build.mjs');
  generateSkills();
  for (const host of Object.keys(HOSTS)) {
    assert.equal(read(host), before[host], `${host} SKILL.md is stale: run node scripts/build.mjs`);
  }
});
