import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { here } from './helpers.mjs';

const skillsDir = path.join(here, '..', 'plugins', 'severally', 'skills');
const file = (host, name) => fs.readFileSync(path.join(skillsDir, host, 'severally', name), 'utf8');
const skill = (host) => file(host, 'SKILL.md');
// What a lead can read: SKILL.md, and reference.md beside it, which SKILL.md
// points to for a decision kept on record. Both are installed together.
const read = (host) => `${skill(host)}\n${file(host, 'reference.md')}`;

const HOSTS = {
  claude: { self: 'Claude Code', peers: ['Codex', 'Antigravity', 'OpenCode'] },
  codex: { self: 'Codex', peers: ['Claude Code', 'Antigravity', 'OpenCode'] },
  antigravity: { self: 'Antigravity', peers: ['Codex', 'Claude Code', 'OpenCode'] },
  opencode: { self: 'OpenCode', peers: ['Codex', 'Claude Code', 'Antigravity'] },
};

test('every host has a skill that names its peers and not itself as the default', () => {
  for (const [host, { self, peers }] of Object.entries(HOSTS)) {
    const text = read(host);
    for (const peer of peers) assert.match(text, new RegExp(peer), `${host} skill must offer ${peer}`);
    assert.match(text.split('\n')[2], /^description:/, `${host} skill needs frontmatter description`);
    assert.ok(
      !new RegExp(`independent opinion, review or structured debate from ${self}`).test(text),
      `${host} skill must not advertise consulting itself`,
    );
  }
});

test('the trigger phrases cover the vendor aliases in both languages', () => {
  for (const host of Object.keys(HOSTS)) {
    const description = read(host)
      .split('\n')
      .find((l) => l.startsWith('description:'));
    const expected =
      host === 'codex'
        ? ['Claudeに聞いて', 'Geminiと相談して', 'GLMに聞いて', 'ask Claude', 'ask Gemini', 'ask GLM']
        : host === 'claude'
          ? ['gptと相談して', 'Geminiと相談して', 'GLMに聞いて', 'ask GPT', 'ask Gemini', 'ask GLM']
          : host === 'antigravity'
            ? ['gptと相談して', 'Claudeに聞いて', 'GLMに聞いて', 'ask GPT', 'ask Claude', 'ask GLM']
            : ['gptと相談して', 'Claudeに聞いて', 'Geminiと相談して', 'ask GPT', 'ask Claude', 'ask Gemini'];
    for (const phrase of expected) {
      assert.ok(description.includes(phrase), `${host} description must contain ${phrase}`);
    }
    assert.ok(description.includes('セカンドオピニオン'));
  }
});

// The host CLI picks a skill by having its model read this description, not by
// matching strings, so the listed phrases are examples that bias that judgement.
// Saying so keeps a wording nobody listed -- a different particle, a synonym --
// from reading as "not covered".
test('the description says its trigger phrases are examples rather than an exact list', () => {
  for (const host of Object.keys(HOSTS)) {
    const description = read(host)
      .split('\n')
      .find((l) => l.startsWith('description:'));
    assert.match(description, /examples, not an exact list/i, `${host} description must say the phrases are examples`);
    assert.match(description, /any wording|any phrasing/i, `${host} description must invite wordings it does not list`);
    assert.ok(
      description.includes('みんなに聞いて'),
      `${host} description should carry a particle variant of the everyone phrasing`,
    );
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
    assert.match(
      text,
      /not agreement|not evidence of agreement/i,
      `${host} skill must warn that matching summaries are not agreement`,
    );
  }
});

// "みんなで相談して" means every consultant this host can reach, its own CLI on
// a fresh session included. Which ones exist is the operator's config, so the
// server counts them: the skill sends targets: ["all"]. The self member is not
// another lineage, so the skill has to say so -- but it is asked, whatever
// model the lead runs as: a fresh session sheds the lead's drift.
test('every skill answers "ask everyone" with all, its own CLI included', () => {
  const PEER_IDS = {
    claude: ['codex', 'antigravity', 'opencode'],
    codex: ['claude-code', 'antigravity', 'opencode'],
    antigravity: ['codex', 'claude-code', 'opencode'],
    opencode: ['codex', 'claude-code', 'antigravity'],
  };
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    const description = text.split('\n').find((l) => l.startsWith('description:'));
    for (const phrase of ['みんなで相談して', '全員に聞いて', 'ask everyone']) {
      assert.ok(description.includes(phrase), `${host} description must contain ${phrase}`);
    }
    assert.match(text, /everyone/i, `${host} skill must explain what "everyone" resolves to`);
    const [p0, p1] = PEER_IDS[host];
    assert.match(text, /targets: \["all"\]/, `${host} skill must show the everyone call as all`);
    assert.match(text, /your own CLI on a fresh session included/, `${host} skill must include itself in everyone`);
    // The default second-opinion rule asks a fresh self session too, and no
    // longer drops it when the lead already runs its lineage's top tier.
    assert.doesNotMatch(
      text,
      /leave\s+the\s+fan-out\s+at\s+the\s+three\s+peers|drops it when you are already running/i,
      `${host} skill must not drop its own CLI from the default fan-out`,
    );
    // The plain two-reading fan-out is still a pair of peers.
    assert.match(
      text,
      new RegExp(`targets: \\["${p0}", "${p1}"\\]`),
      `${host} skill must keep a two-peer fan-out for "two independent readings"`,
    );
    assert.match(text, /not another lineage/i, `${host} skill must keep the self member's caveat`);
    assert.match(text, /concurrency cap/i, `${host} skill must tell the lead how a fan-out relates to the concurrency cap`);
  }
});

test('the generated skills are in sync with the template', async () => {
  const { renderSkills } = await import('../scripts/build.mjs');
  const rendered = renderSkills();
  for (const host of Object.keys(HOSTS)) {
    for (const name of ['SKILL.md', 'reference.md']) {
      assert.equal(rendered[host][name], file(host, name), `${host} ${name} is stale: run node scripts/build.mjs --skills-only`);
    }
  }
});

// SKILL.md enters the lead's context on every consultation, so it holds the
// routine and the rules that must never be skipped; what only a decision kept
// on record needs is in reference.md, read on demand.
test('SKILL.md is the three-call routine, small, and points at reference.md for the rest', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = skill(host);
    assert.ok(Buffer.byteLength(text) < 12_000, `${host} SKILL.md is ${Buffer.byteLength(text)} bytes`);
    const windowsBytes = Buffer.byteLength(text.replace(/\r?\n/g, '\r\n'));
    assert.ok(windowsBytes < 12_000, `${host} SKILL.md is ${windowsBytes} bytes with CRLF`);
    assert.match(text, /## A normal consultation is three calls/);
    assert.match(text, /`reference\.md`, in the same\s+directory as this file/);
    assert.match(text, /## Before you hand the decision back/);
    assert.match(text, /targets: \["all"\]/);
    assert.match(text, /Matching summaries are not agreement/);
    assert.match(text, /Do not pick a model yourself/);
    assert.match(text, /before you ask the user to approve/i);
    assert.doesNotMatch(text, /wait_ms/, 'consult_get waits by default');
    assert.doesNotMatch(text, /^\s*mode: "/m, 'the mode is read from the context');
    assert.doesNotMatch(
      text,
      /consult_export\(|reflection: \{|Asking one consultant to answer another/,
      `${host} SKILL.md carries reference material`,
    );
  }
});

// Asking one consultant to answer another's point is a follow-up the lead
// chooses; what comes back has seen the other side, so it is reported apart.
test('the reference shows how to ask for a rebuttal, and that the answer is no longer independent', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = file(host, 'reference.md');
    assert.match(text, /### Asking one consultant to answer another/);
    assert.match(text, /followup_to/);
    assert.match(text, /no longer an independent opinion/);
  }
});

// A model is named by naming the consultant that runs it, and only when the
// user asked; the skill has to say both halves of that, or an agent will
// either never use it or use it on its own initiative.
test('every skill explains naming a model and that it is user-driven', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.doesNotMatch(text, /:<model>/, `${host} skill must not teach the removed model suffix`);
    assert.match(text, /target: "claude opus"/, `${host} skill must show a model named as the target`);
    assert.match(text, /target_ambiguous/, `${host} skill must say what an ambiguous name comes back as`);
    assert.match(text, /Do not pick a model yourself/i, `${host} skill must forbid choosing a model unasked`);
    assert.match(text, /usage_limit/, `${host} skill must rule out swapping models after a limit failure`);
  }
});

// A machine may lack a peer's CLI entirely. The skill has to tell the agent
// where the real list is, or it will keep offering a consultant that is not there.
test('every skill says the reachable consultants are the ones the tool lists', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /target_unavailable/, `${host} skill must name the refusal it will get`);
    assert.match(text, /actually reach|available list/i, `${host} skill must point at the runtime list`);
  }
});

// The failure this warns about is expensive and silent until the very end:
// a heavy ask that burns the whole budget and returns nothing.
test('every skill warns that scope, not length, is what times a consultation out', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /one\s+decidable question/i, `${host} skill must say what to ask for`);
    assert.match(text, /\bprogress\b/, `${host} skill must point at the running progress`);
    assert.match(text, /consult_cancel/, `${host} skill must offer cutting it short`);
  }
});

// Six live runs (three hosts x with/without these instructions) never missed a
// finding, but three of them erased the disagreement between two consultants
// whose findings overlapped and whose bottom lines were opposite, and two
// discarded the same-vendor consultant's findings outright because the caveat
// said to prefer the others. The skill has to name both traps.
test('every skill points at the stance column and forbids discarding a same-vendor answer unread', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /`stance`/, `${host} skill must point at the stance column`);
    assert.match(
      text,
      /same finding|share a finding|shared finding/i,
      `${host} skill must warn about shared findings with opposite stances`,
    );
    assert.doesNotMatch(text, /for nothing/, `${host} skill must not call a same-vendor slot worthless`);
    assert.match(text, /not a reason to (skip|discard|dismiss)/i, `${host} skill must say the caveat is not a reason to discard`);
  }
});

test('every skill closes a consultation by recording what checking showed', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /consult_record/, `${host} skill must tell the lead how to record a verdict`);
    for (const verdict of ['unverified', 'confirmed', 'not_applicable', 'unverifiable']) {
      assert.match(text, new RegExp(verdict), `${host} skill must name the verdict "${verdict}"`);
    }
    assert.match(text, /f1/, `${host} skill must say where the ids come from`);
  }
});

test('every skill offers the export for a decision that belongs in the repository', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /consult_export/, `${host} skill must mention how to keep the record in the repo`);
  }
});

test('every skill has the lead commit to a prediction before the consultant runs', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /prediction/, `${host} skill must show how to record a prediction`);
    assert.match(text, /reflection/, `${host} skill must show how to record what the answer added`);
  }
});

test('every skill offers the explore-then-review pair for a heavy decision', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /explore` first|explore first/i, `${host} skill must describe the pair`);
  }
});

// The consultation is not over when the answer arrives. Before the lead hands
// the decision back to the user, it runs the one check that would change the
// decision and says what is still unverified -- otherwise "we consulted" is a
// list of opinions the user has to check themselves.
test('every skill closes by running the decision-critical check and naming what stays unverified', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /## Before you hand the decision back/, `${host} skill must have the hand-back section`);
    assert.match(text, /one check that would change the decision/i, `${host} skill must ask for one decisive check`);
    assert.match(text, /still unverified/i, `${host} skill must ask the lead to name what is still unverified`);
    assert.match(
      text,
      /consult_record\(\{ job_id: "\.\.\.", entries: \[\s*\{ id: "c1", verdict: "confirmed"/,
      `${host} skill must show recording the check it ran`,
    );
  }
});

// At the moment the agent would ask "may I proceed?" on a hard-to-reverse
// change, it consults first and comes to the user with what it checked,
// rather than asking whether to consult: the user asked to be consulted only
// on what is theirs to decide (2026-10-19).
test('every skill consults before asking approval of a hard-to-reverse change, without asking whether to', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /before you ask the user to approve/i, `${host} skill must attach to the approval moment`);
    assert.match(text, /consult first/i, `${host} skill must consult before asking`);
    assert.match(text, /Do not ask whether to consult/, `${host} skill must not offer instead of consulting`);
    assert.match(
      text,
      /must\s+not reach another vendor's model/,
      `${host} skill must still ask before sending material that must stay`,
    );
  }
});

// A lead on one model may consult a different model of the same vendor -- an
// Opus lead asking Fable, or the reverse. The skill has to name that use and
// tell the lead to declare its own model, so the caveat can say which model
// answered instead of only "the same vendor's model family".
test('every skill covers consulting a different model of its own lineage', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /caller_model/, `${host} skill must tell the lead to declare its model`);
    assert.match(text, /different model of your own lineage/i, `${host} skill must name the different-model use`);
    assert.doesNotMatch(text, /stronger model of the same lineage/i, `${host} skill must not frame it as escalation only`);
  }
});

// The history tells consultations the user asked for from the ones the lead
// started itself.
test('every skill records who asked for a consultation', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.match(text, /initiator: "user"/, `${host} skill must mark a consultation the user asked for`);
    assert.match(text, /leave it out when you started it yourself/, `${host} skill must leave the lead's own out`);
    assert.doesNotMatch(text, /offer_accepted|consult_offer_declined\(/, `${host} skill no longer offers`);
  }
});

// One rule decides how many consultants to ask (under "Pick the consultant").
// A line that recommends a smaller default elsewhere contradicts it.
test('no skill recommends a smaller default than the one consultant-count rule', () => {
  for (const host of Object.keys(HOSTS)) {
    const text = read(host);
    assert.doesNotMatch(text, /so two is\s+usually enough/i, `${host} skill must not recommend two as the default`);
    assert.doesNotMatch(text, /The first consultation is small/, `${host} skill must say the brief is small, not the count`);
  }
});

test("the README's npx line names the version being released", async () => {
  const fs = await import('node:fs');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const readme of ['README.md', 'README.ja.md']) {
    const text = fs.readFileSync(new URL(`../${readme}`, import.meta.url), 'utf8');
    const named = [...text.matchAll(/severally-mcp@(\d+\.\d+\.\d+) install/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `${readme} has an npx line`);
    for (const v of named) assert.equal(v, version, `${readme} names ${v}, the package is ${version}`);
  }
});

// The one-line description is the same sentence in the README and in
// package.json, so npm and the repository say one thing.
test("the README's short description is package.json's description", async () => {
  const fs = await import('node:fs');
  const { description } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lines = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes(description), `README.md has no line reading: ${description}`);
  assert.ok(description.length < 120);
});
