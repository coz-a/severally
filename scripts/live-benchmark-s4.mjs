// Resume S4 only after an evaluator supplies actual checks. Verification and
// adoption remain separate from a judgement that the whole scenario succeeded.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { redact } from '../src/redact.mjs';

/** @param {unknown} value */
const text = (value) => typeof value === 'string' && value.trim().length > 0;
/** @param {string} value @param {number} max */
function storedText(value, max) {
  const clean = redact(value).trim();
  const marker = '\n…[truncated by severally]';
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - marker.length))}${marker}` : clean;
}

/** @param {{receiptPath: string, assessmentPath: string, manifestPath: string, manager: import('../src/jobs.mjs').JobManager}} options */
export async function resumeS4({ receiptPath, assessmentPath, manifestPath, manager }) {
  const lockPath = `${receiptPath}.s4.lock`;
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  /** @type {string | null} */
  let startedFollowupId = null;
  /** @type {NodeJS.Timeout | undefined} */
  let deadlineTimer;
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const assessment = JSON.parse(fs.readFileSync(assessmentPath, 'utf8'));
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const budget = manifest.consultation_budget_ms ?? null;
    if (budget !== null && (!Number.isSafeInteger(budget) || budget < 1 || budget > 1_800_000))
      throw new Error('consultation_budget_ms must be an integer from 1 to 1800000');
    if (receipt.scenario !== 'S4' || receipt.outcome !== 'awaiting_assessment')
      throw new Error('S4 receipt state requires reconciliation before another follow-up');
    if (
      !text(receipt.job_id) ||
      !/^[0-9a-f]{64}$/.test(receipt.followup_question_sha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(receipt.manifest_sha256 ?? '')
    )
      throw new Error('S4 receipt lacks a fixed job, manifest or follow-up question');
    if (
      crypto.createHash('sha256').update(manifestBytes).digest('hex') !== receipt.manifest_sha256 ||
      manifest.scenario !== 'S4' ||
      !text(manifest.followup_question) ||
      crypto.createHash('sha256').update(manifest.followup_question).digest('hex') !== receipt.followup_question_sha256
    )
      throw new Error('the fixed manifest or follow-up question does not match the receipt');
    if (assessment.job_id !== receipt.job_id || assessment.manifest_sha256 !== receipt.manifest_sha256)
      throw new Error('assessment job or manifest does not match the receipt');
    if (!Array.isArray(assessment.entries) || !assessment.entries.length) throw new Error('assessment entries are required');
    const ids = new Set();
    for (const entry of assessment.entries) {
      if (!text(entry.id) || ids.has(entry.id) || !text(entry.method) || !text(entry.result) || !text(entry.scope))
        throw new Error('each assessment needs a unique point ID, method, result and scope');
      if (!['confirmed', 'refuted', 'not_applicable', 'unverifiable', 'unverified'].includes(entry.verdict))
        throw new Error('invalid verification verdict');
      if (!['adopt', 'revise', 'reject'].includes(entry.adoption)) throw new Error('invalid adoption decision');
      ids.add(entry.id);
    }
    const original = manager.view(receipt.job_id, { detail: 'full' });
    if (!original || original.status !== 'completed' || !original.result)
      throw new Error('initial completed answer is unavailable');
    const known = new Set(
      [...original.result.findings, ...original.result.unknowns, ...original.result.next_checks].map((p) => p.id),
    );
    if (assessment.entries.some((/** @type {{id: string}} */ entry) => !known.has(entry.id)))
      throw new Error('assessment refers to a point not present in the answer');
    const saved = manager.record({
      job_id: receipt.job_id,
      entries: assessment.entries.map((/** @type {any} */ entry) => ({
        id: entry.id,
        verdict: entry.verdict,
        effect: `evaluator decision: ${entry.adoption}`,
        note: `method: ${entry.method}; result: ${entry.result}; scope: ${entry.scope}`,
      })),
    });
    if ('error' in saved && saved.error) throw new Error('verification record was not saved');
    const persisted = manager.view(receipt.job_id, { detail: 'full' });
    if (
      !persisted?.record ||
      assessment.entries.some((/** @type {any} */ entry) => {
        const written = persisted.record?.entries.find((e) => e.id === entry.id);
        const note = `method: ${entry.method}; result: ${entry.result}; scope: ${entry.scope}`;
        return (
          !written ||
          written.verdict !== entry.verdict ||
          written.effect !== storedText(`evaluator decision: ${entry.adoption}`, 4000) ||
          written.followup_note !== storedText(note, 400)
        );
      })
    )
      throw new Error('verification record changed or does not match the saved assessment');
    const temporary = `${receiptPath}.tmp-${process.pid}`;
    const save = () => {
      fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, receiptPath);
    };
    receipt.adoption = { adopt: 0, revise: 0, reject: 0 };
    for (const entry of assessment.entries) receipt.adoption[entry.adoption]++;
    receipt.assessed_point_ids = [...ids];
    receipt.followup_notes_truncated = persisted.record.entries
      .filter((entry) => ids.has(entry.id) && entry.followup_note?.includes('[truncated by severally]'))
      .map((entry) => entry.id);
    receipt.scenario_assessment = null;
    receipt.followup_evidence_delivery_verified = null;
    receipt.followup_evidence_note =
      'The sent brief is not independently verified against this assessment; concurrent record updates and history limits can change which notes are included.';
    // A crash after this write requires reconciliation, not a duplicate run.
    receipt.outcome = 'followup_submission_uncertain';
    save();
    const followupStarted = Date.now();
    const started = manager.start({ followup_to: receipt.job_id, question: manifest.followup_question });
    if (!('job_id' in started)) throw new Error('S4 requires one follow-up member');
    startedFollowupId = started.job_id;
    let terminationReason = 'consultant_failure';
    if (budget !== null)
      deadlineTimer = setTimeout(() => {
        terminationReason = 'benchmark_deadline';
        manager.cancel(started.job_id);
      }, budget);
    receipt.followup = {
      job_id: started.job_id,
      status: 'running',
      started_at: new Date(followupStarted).toISOString(),
      duration_ms: null,
      usage: null,
      failure_kind: null,
      consultation_budget_ms: budget,
      termination_reason: null,
    };
    save();
    await manager.jobs.get(started.job_id)?.promise;
    clearTimeout(deadlineTimer);
    const followup = manager.view(started.job_id);
    receipt.followup = {
      job_id: started.job_id,
      status: followup?.status ?? 'unknown',
      started_at: new Date(followupStarted).toISOString(),
      duration_ms: Date.now() - followupStarted,
      usage: followup?.usage ?? null,
      failure_kind: followup?.failure?.kind ?? null,
      consultation_budget_ms: budget,
      termination_reason: followup?.status === 'completed' ? 'completed' : terminationReason,
    };
    receipt.outcome = followup?.status === 'completed' ? 'followup_completed' : 'followup_failed';
    save();
    return receipt;
  } catch (error) {
    if (startedFollowupId) {
      manager.cancel(startedFollowupId);
      await manager.jobs.get(startedFollowupId)?.promise;
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
