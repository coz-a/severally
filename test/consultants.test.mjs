import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelWords, modelStem, modelVersion, vendorOf, matchesWords, resolveConsultant, sameModel, buildConsultants,
  DEFAULT_MODELS, CLI_IDS,
} from '../src/consultants.mjs';

const c = (name, cli, model, extra = {}) => Object.freeze({
  name, cli, model, effort: null, timeoutMs: null, maxBudgetUsd: null,
  vendor: vendorOf(model, extra.vendor ?? null), enabled: true, note: null, ...extra,
});
const pick = (r) => r.consultant?.name;

test('a model id splits into words after its provider prefix', () => {
  assert.deepEqual(modelWords('zai-coding-plan/glm-5.3'), ['glm', '5', '3']);
  assert.deepEqual(modelWords('opencode/nemotron-3-ultra-free#'), ['nemotron', '3', 'ultra', 'free']);
});

test('the stem is the words before the version, and the version is its digits', () => {
  assert.deepEqual(modelStem('gpt-6.1-sol'), ['gpt']);
  assert.deepEqual(modelVersion('gpt-6.1-sol'), [6, 1]);
  assert.deepEqual(modelVersion('deepseek-v4.1-flash-free'), [4, 1]);
  assert.deepEqual(modelStem('claude-opus-5-5'), ['claude', 'opus']);
  assert.equal(modelVersion('sonnet'), null);
});

test('the vendor comes from the model stem unless the operator names it', () => {
  assert.equal(vendorOf('gpt-6-astra'), 'openai');
  assert.equal(vendorOf('zai-coding-plan/glm-5.3'), 'zai');
  assert.equal(vendorOf('acme-1', 'acme'), 'acme');
  assert.equal(vendorOf('acme-1'), null);
});

test('a name matches a model by whole words, not by substring', () => {
  assert.equal(matchesWords('claude-opus-5-5', 'Claude Opus'), true);
  assert.equal(matchesWords('zai-coding-plan/glm-5.2', 'glm-5.2'), true);
  assert.equal(matchesWords('gpt-6.1-sol', 'g'), false);
});

test('a consultant\'s own name wins over a CLI name it happens to share', () => {
  const list = [c('codex', 'opencode', 'x/glm-5.3'), c('astra', 'codex', 'gpt-6-astra')];
  assert.equal(pick(resolveConsultant('codex', list, [])), 'codex');
});

test('a CLI name reaches the consultants on that CLI', () => {
  const list = [c('g', 'antigravity', 'gemini-4-argon-high'), c('d', 'opencode', 'opencode/deepseek-v4.1-flash-free')];
  assert.equal(pick(resolveConsultant('agy', list, [])), 'g');
});

test('a vendor word reaches that vendor\'s consultants on any CLI', () => {
  const list = [c('o', 'opencode', 'anthropic/claude-sonnet-5-5'), c('x', 'codex', 'gpt-6-astra')];
  assert.equal(pick(resolveConsultant('anthropic', list, [])), 'o');
});

test('a model word reaches the consultant running that model', () => {
  const list = [c('glm', 'opencode', 'zai-coding-plan/glm-5.3'), c('ds', 'opencode', 'opencode/deepseek-v4.1-flash-free')];
  assert.equal(pick(resolveConsultant('GLM', list, [])), 'glm');
});

test('the newer version wins within one stem', () => {
  const glm = [c('a', 'opencode', 'zai-coding-plan/glm-5.2'), c('b', 'opencode', 'zai-coding-plan/glm-5.3')];
  assert.equal(pick(resolveConsultant('glm', glm, [])), 'b');
  const gpt = [c('astra', 'codex', 'gpt-6-astra'), c('sol', 'codex', 'gpt-6.1-sol')];
  assert.equal(pick(resolveConsultant('gpt', gpt, [])), 'sol');
});

test('the tier wins over the version, and effort words rank too', () => {
  const claude = [c('sonnet', 'claude-code', 'claude-sonnet-6'), c('opus', 'claude-code', 'claude-opus-5-5')];
  assert.equal(pick(resolveConsultant('claude', claude, [])), 'opus');
  const gemini = [c('lo', 'antigravity', 'gemini-4-argon-low'), c('hi', 'antigravity', 'gemini-4-argon-high')];
  assert.equal(pick(resolveConsultant('gemini', gemini, [])), 'hi');
});

test('the operator\'s ranking comes first, and an entry that matches nothing changes nothing', () => {
  const claude = [c('sonnet', 'claude-code', 'claude-sonnet-6'), c('opus', 'claude-code', 'claude-opus-5-5')];
  assert.equal(pick(resolveConsultant('claude', claude, ['sonnet'])), 'sonnet');
  assert.equal(pick(resolveConsultant('claude', claude, ['nonexistent'])), 'opus');
});

test('candidates that no rule can order are refused as ambiguous', () => {
  const mixed = [c('glm', 'opencode', 'zai-coding-plan/glm-5.3'), c('ds', 'opencode', 'opencode/deepseek-v4.1-flash-free')];
  const r = resolveConsultant('opencode', mixed, []);
  assert.deepEqual(r.ambiguous.map((x) => x.name), ['glm', 'ds']);
  const tie = [c('one', 'opencode', 'zai-coding-plan/glm-5.3'), c('two', 'opencode', 'other/glm-5.3')];
  assert.ok(resolveConsultant('glm', tie, []).ambiguous);
});

test('a name nobody matches is reported as no match', () => {
  assert.deepEqual(resolveConsultant('mistral', [c('a', 'codex', 'gpt-6-astra')], []), { none: true });
});

test('same model, unknown and different are told apart without guessing', () => {
  assert.equal(sameModel('Claude Opus 5.5', 'claude-opus-5-5'), 'same');
  assert.equal(sameModel('claude-opus-5', 'claude-opus-5-5'), 'unknown');
  assert.equal(sameModel('claude-sonnet-5-5', 'claude-opus-5-5'), 'different');
});

test('with no consultants configured, each CLI gets one on its default model', () => {
  const r = buildConsultants({});
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.consultants.map((x) => [x.name, x.cli, x.model]),
    CLI_IDS.map((id) => [id, id, DEFAULT_MODELS[id]]));
});

test('configured consultants are the whole list, with no defaults added', () => {
  const r = buildConsultants({ consultants: { glm: { cli: 'opencode', model: 'zai-coding-plan/glm-5.3' } } });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.consultants.map((x) => x.name), ['glm']);
  assert.equal(r.consultants[0].vendor, 'zai');
});

test('each config mistake is reported, naming the key', () => {
  const cases = [
    [{ targets: {} }, /targets/],
    [{ consultants: { a: { cli: 'vim', model: 'm' } } }, /consultants\.a\.cli/],
    [{ consultants: { a: { cli: 'codex' } } }, /consultants\.a\.model/],
    [{ consultants: { a: { cli: 'codex', model: 'm' }, b: { cli: 'codex', model: 'm' } } }, /same cli and model/],
    [{ consultants: { all: { cli: 'codex', model: 'm' } } }, /reserved/],
    [{ ranking: 'x' }, /ranking/],
    [{ consultants: { a: { cli: 'codex', model: 'm', max_budget_usd: 3 } } }, /max_budget_usd/],
    [{ consultants: { a: { cli: 'antigravity', model: 'gemini-4-argon-high', effort: 'high' } } }, /effort/],
  ];
  for (const [config, pattern] of cases) {
    const r = buildConsultants(config);
    assert.ok(r.problems.some((p) => pattern.test(p)), `${JSON.stringify(config)} -> ${JSON.stringify(r.problems)}`);
  }
});

test('the built-in tiers only order models of one family', () => {
  const free = [c('nemotron', 'opencode', 'opencode/nemotron-3-ultra-free#'), c('deepseek', 'opencode', 'opencode/deepseek-v4.1-flash-free')];
  assert.ok(resolveConsultant('free', free, []).ambiguous, 'gemini tiers must not order nemotron against deepseek');
  const effort = [c('ds', 'opencode', 'x/deepseek-v4-high'), c('glm', 'opencode', 'x/glm-5-low')];
  assert.ok(resolveConsultant('opencode', effort, []).ambiguous, 'effort words only within one stem');
  const opus = [c('a', 'opencode', 'acme/opus-mini-2'), c('b', 'opencode', 'anthropic/claude-sonnet-5')];
  assert.ok(resolveConsultant('opencode', opus, []).ambiguous, 'claude tiers only between claude models');
});

test('a clis value of the wrong type is a problem, not a silent default', () => {
  const cases = [
    [{ clis: { codex: { enabled: 'false' } } }, /clis\.codex\.enabled/],
    [{ clis: { codex: { bin: 42 } } }, /clis\.codex\.bin/],
    [{ clis: { codex: { note: 1 } } }, /clis\.codex\.note/],
    [{ clis: { codex: { args: '--x' } } }, /clis\.codex\.args/],
    [{ clis: { codex: { env: ['A=1'] } } }, /clis\.codex\.env/],
  ];
  for (const [config, pattern] of cases) {
    const r = buildConsultants(config);
    assert.ok(r.problems.some((p) => pattern.test(p)), `${JSON.stringify(config)} -> ${JSON.stringify(r.problems)}`);
  }
});

test('doctor checks each CLI once, and a CLI name picks its first available consultant', async () => {
  const { checkTargets } = await import('../src/consultants.mjs');
  const glm = c('glm', 'opencode', 'zai-coding-plan/glm-5.3');
  const ds = c('deepseek', 'opencode', 'opencode/deepseek-v4.1-flash-free');
  const sol = c('sol', 'codex', 'gpt-6.1-sol');
  assert.deepEqual(checkTargets(null, [glm, ds, sol], [glm, ds, sol], []).map((x) => x.name), ['glm', 'sol']);
  assert.deepEqual(checkTargets('opencode', [ds, sol], [glm, ds, sol], []).map((x) => x.name), ['deepseek'],
    'the first one that can run, not an ambiguity');
  assert.deepEqual(checkTargets('glm', [glm, ds], [glm, ds], []).map((x) => x.name), ['glm']);
  assert.equal(checkTargets('mistral', [glm], [glm], []), null);
});
