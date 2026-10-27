import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnv, reviewRequest } from './helpers.mjs';

sandboxEnv();
const { JobManager, pointsOf } = await import('../src/jobs.mjs');
const { POLICY } = await import('../src/policy.mjs');
const store = await import('../src/store.mjs');

// What one finished fan-out may take by default, as the server prints it
// (JSON, two-space indent): under the MCP output cap a client applies, so the
// lead reads the side-by-side instead of having it spilled to a file.
const GROUP_MAX = 19_500;
const size = (v) => JSON.stringify(v, null, 2).length;

const ALL = ['codex', 'claude-code', 'antigravity'];

// A result of a given shape: `n` items per list, `len` characters per text.
function result(n, len, summaryLen = len) {
  const t = (c) => c.repeat(len);
  const range = (p) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
  return {
    summary: 's'.repeat(summaryLen),
    recommendation: 'a'.repeat(len),
    stance: 'proceed',
    confidence: 'medium',
    evidence_basis: 'adequate',
    findings: range('f').map((id) => ({
      id,
      point: t('p'),
      grounds: t('g'),
      impact: t('i'),
      severity: 'high',
      confidence: 'high',
    })),
    alternatives: range('a').map(() => ({ option: t('o'), tradeoffs: t('t'), when_preferred: t('w') })),
    unknowns: range('u').map((id) => ({ id, item: t('u'), why_it_matters: t('y'), how_to_obtain: t('h') })),
    decision_changers: range('d').map(() => ({ condition: t('c'), changes_to: t('x') })),
    next_checks: range('c').map((id) => ({ id, check: t('k'), method: t('m'), expected_signal: t('e') })),
    remaining_disagreements: range('r').map(() => ({ topic: t('r'), your_position: t('q'), why_unresolved: t('z') })),
    references: [],
  };
}

// A finished fan-out whose answers are then swapped for the given ones: the
// size of the view depends only on what the consultants wrote.
async function fanout(mgr, targets, answers) {
  process.env.STUB_BEHAVIOR = 'ok';
  const started = mgr.start(reviewRequest({ target: undefined, targets }));
  const jobs = started.jobs.map((j) => mgr.jobs.get(j.job_id));
  await Promise.all(jobs.map((j) => j.promise));
  jobs.forEach((j, i) => {
    Object.assign(j, answers[i]);
    store.persistRound({ ...store.loadRoundAt(j), ...answers[i] }, { appendIndex: false });
  });
  return started;
}

const big = { result: result(10, 300, 2_000) }; // about 11,000 characters of result, as measured on 2026-10-18
const maxed = {
  result: result(POLICY.output.listMax, POLICY.output.itemTextMax, POLICY.output.summaryMax),
  quality: { caveat: 'v'.repeat(4_000) },
};

test('a short fan-out exposes each finding with its grounds and actual answering model', async () => {
  const mgr = new JobManager();
  const answers = ALL.map((_, i) => ({ model: `answering-model-${i}`, result: result(2, 50, 100) }));
  const s = await fanout(mgr, ALL, answers);
  const view = mgr.groupView(s.group_id);
  for (const [i, column] of view.comparison.by_target.entries()) {
    assert.equal(column.model, answers[i].model);
    assert.deepEqual(
      column.finding_points,
      answers[i].result.findings.map(({ id, severity, point, grounds }) => ({ id, severity, point, grounds })),
    );
    assert.equal(column.truncated, undefined);
    assert.deepEqual(mgr.view(column.job_id).result, answers[i].result, 'the stored answer stays whole');
  }
  assert.ok(size(view) <= 19_500);
});

test('clipped grounds are marked and can be fetched whole by finding id', async () => {
  const mgr = new JobManager();
  const answer = { result: result(1, 4_000, 100) };
  const s = await fanout(mgr, ALL, [answer, answer, answer]);
  const view = mgr.groupView(s.group_id);
  for (const column of view.comparison.by_target) {
    const finding = column.finding_points[0];
    assert.equal(typeof finding.grounds, 'string');
    assert.ok(finding.grounds.length < answer.result.findings[0].grounds.length);
    assert.equal(column.truncated, true);
    assert.match(view.next_step, /ids/);
    const selected = pointsOf(mgr.view(column.job_id), [finding.id]);
    assert.equal(selected.points[0].grounds, answer.result.findings[0].grounds);
  }
  assert.ok(size(view) <= 19_500);
});

test('long answering model identifiers fit and expose their complete value through the job view', async () => {
  const mgr = new JobManager();
  const answer = { model: 'custom-model-'.repeat(2_000), result: result(2, 50, 100) };
  const s = await fanout(mgr, ALL, [answer, answer, answer]);
  const view = mgr.groupView(s.group_id);
  assert.ok(size(view) <= GROUP_MAX, `${size(view)} > ${GROUP_MAX}`);
  for (const column of view.comparison.by_target) {
    assert.equal(column.truncated, true);
    assert.ok(column.model.endsWith('…'));
    assert.equal(mgr.view(column.job_id).model, answer.model);
  }
});

test('a three-way fan-out of 11,000-character answers fits one response', async () => {
  const mgr = new JobManager();
  assert.ok(JSON.stringify(big.result).length > 11_000);
  const s = await fanout(mgr, ALL, [big, big, big]);
  const view = mgr.groupView(s.group_id);
  assert.ok(size(view) <= GROUP_MAX, `${size(view)} > ${GROUP_MAX}`);
  const full = mgr.groupView(s.group_id, { detail: 'full' });
  assert.ok(size(full) <= GROUP_MAX + size(full.brief), 'detail: "full" adds the brief, not every answer again');
  for (const m of full.members) assert.equal(m.result, undefined);
});

test('answers at every length cap still fit, and say they were cut', async () => {
  const mgr = new JobManager();
  const s = await fanout(mgr, ALL, [maxed, maxed, maxed]);
  const view = mgr.groupView(s.group_id);
  assert.ok(size(view) <= GROUP_MAX, `${size(view)} > ${GROUP_MAX}`);
  for (const t of view.comparison.by_target) {
    assert.equal(t.truncated, true);
    assert.equal(t.full_with, `consult_get({ job_id: "${t.job_id}" })`);
    assert.ok(t.summary.length <= 1_201);
  }
});

test('the most consultants a fan-out can hold still fit', async () => {
  const mgr = new JobManager();
  const ids = [];
  for (let i = 0; i < POLICY.maxConcurrent; i += 3) {
    const s = await fanout(mgr, ALL, [maxed, maxed, maxed]);
    ids.push(...s.jobs.map((j) => j.job_id));
  }
  const groupId = 'group_000000000000';
  mgr.groups.set(groupId, { group_id: groupId, mode: 'review', question: 'q', job_ids: ids.slice(0, POLICY.maxConcurrent) });
  const view = mgr.groupView(groupId);
  assert.equal(view.members.length, POLICY.maxConcurrent);
  assert.ok(size(view) <= GROUP_MAX, `${size(view)} > ${GROUP_MAX}`);
});

test('a partly failed fan-out fits, and its failure is cut, not dropped', async () => {
  const mgr = new JobManager();
  const failed = {
    result: null,
    quality: null,
    status: 'failed',
    failure: {
      kind: 'cli_error',
      message: 'm'.repeat(4_000),
      detail: 'd'.repeat(1_200),
      retriable: true,
      delivered_advice: false,
    },
  };
  const s = await fanout(mgr, ALL, [maxed, failed, maxed]);
  const view = mgr.groupView(s.group_id);
  assert.ok(size(view) <= GROUP_MAX, `${size(view)} > ${GROUP_MAX}`);
  const m = view.members[1];
  assert.equal(m.failure.kind, 'cli_error');
  assert.ok(m.failure.message.length < 400);
  assert.equal(mgr.view(m.job_id).failure.message.length, 4_000, 'the job view keeps the whole message');
});

test("nothing the old view carried is lost: the group plus each member's own view hold all of it", async () => {
  const mgr = new JobManager();
  const s = await fanout(mgr, ALL, [big, big, big]);
  const full = mgr.groupView(s.group_id, { detail: 'full' });
  const compact = mgr.groupView(s.group_id);
  for (const m of full.members) {
    // A member's own view holds its whole answer, its brief named by sha256.
    const { brief, ...own } = mgr.view(m.job_id);
    assert.equal(own.status, m.status);
    assert.equal(brief.sha256, compact.brief.sha256, 'every member was sent the same brief');
    assert.deepEqual(mgr.view(m.job_id, { detail: 'full' }).brief, full.brief);
    // Every point in the side-by-side carries an id the lead can record
    // against; a point left out is the tail, and the column says so.
    const col = compact.comparison.by_target.find((t) => t.job_id === m.job_id);
    const ids = col.finding_points.map((f) => f.id);
    assert.deepEqual(
      ids,
      own.result.findings.map((f) => f.id),
      'every finding keeps its id',
    );
    assert.equal(col.truncated, true);
    assert.equal(col.points_without_verdict, 30);
  }
});

test('a question and failure messages that JSON escapes still fit, and every cut says so', async () => {
  const mgr = new JobManager();
  const ids = [];
  const failed = {
    result: null,
    quality: null,
    status: 'failed',
    failure: { kind: 'cli_error', message: '\u001b'.repeat(4_000), detail: 'd', retriable: true, delivered_advice: false },
  };
  for (let i = 0; i < POLICY.maxConcurrent; i += 3) {
    const s = await fanout(mgr, ALL, [maxed, failed, maxed]);
    ids.push(...s.jobs.map((j) => j.job_id));
  }
  const groupId = 'group_000000000002';
  mgr.groups.set(groupId, {
    group_id: groupId,
    mode: 'review',
    question: '\u0001'.repeat(4_000),
    job_ids: ids.slice(0, POLICY.maxConcurrent),
  });
  const view = mgr.groupView(groupId);
  assert.ok(size(view) <= GROUP_MAX, `${size(view)} > ${GROUP_MAX}`);
  assert.match(view.question_full_with, /detail: "full"/);
  for (const m of view.members.filter((x) => x.failure)) {
    assert.equal(m.truncated, true);
    assert.equal(m.full_with, `consult_get({ job_id: "${m.job_id}" })`);
  }
});

test('a list that could not hold every item says how many it left out', async () => {
  const mgr = new JobManager();
  const s = await fanout(mgr, ALL, [maxed, maxed, maxed]);
  const view = mgr.groupView(s.group_id);
  const n = POLICY.output.listMax;
  for (const t of view.comparison.by_target) {
    for (const k of [
      'finding_points',
      'decision_changers',
      'alternative_options',
      'unknowns',
      'next_checks',
      'remaining_disagreements',
    ]) {
      assert.equal(t[k].length + (t.omitted?.[k] ?? 0), n, k);
    }
    // The ids the lead records against survive the cut, for every list that has them.
    for (const k of ['finding_points', 'unknowns', 'next_checks'])
      assert.ok(
        t[k].every((x) => /^[fuc]\d+$/.test(x.id)),
        k,
      );
  }
  assert.match(view.brief.full_with, new RegExp(`group_id: "${s.group_id}"`));
});

test('a short answer is not marked truncated, and what it leaves goes to the long ones', async () => {
  const mgr = new JobManager();
  const short = { result: result(2, 50, 100) };
  const s = await fanout(mgr, ALL, [short, maxed, maxed]);
  const [a, b] = mgr.groupView(s.group_id).comparison.by_target;
  assert.equal(a.truncated, undefined);
  assert.equal(a.full_with, undefined);
  const t = await fanout(mgr, ALL, [maxed, maxed, maxed]);
  const c = mgr.groupView(t.group_id).comparison.by_target[1];
  assert.ok(size(b) > size(c), `${size(b)} <= ${size(c)}: the spare budget was not passed on`);
});
