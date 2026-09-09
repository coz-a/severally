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

// Fan-out is the branch's headline feature and it lives entirely in the tool
// arguments, so a skill that never mentions it makes the feature unreachable
// for the agent that is supposed to use it.
test('every skill teaches the fan-out: targets, group_id, and that agreement is not free', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /\btargets\b/, `${host} skill must document targets: [...]`);
    assert.match(text, /\bgroup_id\b/, `${host} skill must document polling by group_id`);
    assert.match(text, /consult_get\(\{ group_id/, `${host} skill must show how to poll a fan-out`);
    assert.match(text, /consult_cancel\(\{ group_id/, `${host} skill must show how to cancel a fan-out`);
    assert.match(text, /comparison\.by_target/, `${host} skill must point at the side-by-side`);
    assert.match(text, /identical brief/i, `${host} skill must say every consultant gets the same brief`);
    assert.match(text, /not agreement|not evidence of agreement/i,
      `${host} skill must warn that matching summaries are not agreement`);
  }
});

test('the generated skills are in sync with the template', async () => {
  const { renderSkills } = await import('../scripts/build.mjs');
  const rendered = renderSkills();
  for (const host of Object.keys(HOSTS)) {
    assert.equal(rendered[host], read(host), `${host} SKILL.md is stale: run node scripts/build.mjs --skills-only`);
  }
});
