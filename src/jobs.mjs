// Job lifecycle: validation, round/concurrency enforcement, child execution,
// classification, history, cancellation.

import crypto from 'node:crypto';
import path from 'node:path';
import { POLICY, limitsSummary, timeoutMs } from './policy.mjs';
import { parseRequest, RequestError } from './schema.mjs';
import { renderBrief, renderGuardrails } from './brief.mjs';
import { CONSULT_RESULT_SCHEMA } from './result-schema.mjs';
import { normalizeResult, OutputError } from './parse-result.mjs';
import { redact } from './redact.mjs';
import { isRetriable } from './failures.mjs';
import { childEnv, runChild } from './run.mjs';
import * as store from './store.mjs';
import * as codex from './adapters/codex.mjs';
import * as claudeCode from './adapters/claude-code.mjs';
import * as antigravity from './adapters/antigravity.mjs';

const ADAPTERS = { codex, 'claude-code': claudeCode, antigravity };

const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

export class JobManager {
  constructor() {
    this.jobs = new Map();
    this.order = [];
    store.ensureDirs();
  }

  get running() {
    return [...this.jobs.values()].filter((j) => j.status === 'running');
  }

  #record(job) {
    return {
      job_id: job.job_id,
      chain_id: job.chain_id,
      round: job.round,
      target: job.target,
      mode: job.mode,
      status: job.status,
      model: job.model,
      question: job.question,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      duration_ms: job.duration_ms,
      result: job.result,
      quality: job.quality,
      usage: job.usage,
      failure: job.failure,
      references_count: job.result ? job.result.references.length : null,
      followup_to: job.followup_to,
      rounds_used: job.round,
      rounds_remaining: Math.max(0, POLICY.maxRounds - job.round),
    };
  }

  view(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const rec = this.#record(job);
    rec.cancellable = job.status === 'running' || job.status === 'queued';
    rec.limits = limitsSummary();
    rec.next_step = nextStep(job);
    return rec;
  }

  list({ limit = 20 } = {}) {
    return this.order
      .slice(-limit)
      .reverse()
      .map((jid) => {
        const j = this.jobs.get(jid);
        return {
          job_id: j.job_id,
          chain_id: j.chain_id,
          round: j.round,
          target: j.target,
          mode: j.mode,
          status: j.status,
          failure_kind: j.failure?.kind ?? null,
          created_at: j.created_at,
          duration_ms: j.duration_ms,
          summary: j.result ? j.result.summary.slice(0, 200) : null,
        };
      });
  }

  start(rawRequest) {
    if (process.env.PEER_CONSULT_ACTIVE === '1') {
      throw new RequestError(
        'this process is itself running as a peer consultant; nested consultations are not allowed',
        'recursion_blocked',
      );
    }
    if (this.running.length >= POLICY.maxConcurrent) {
      throw new RequestError(
        `${POLICY.maxConcurrent} consultations are already running; wait for one to finish (consult_get) or cancel it`,
        'concurrency_limit',
      );
    }

    // Resolve the chain before validating, so follow-up rules can be applied.
    const followupTo = typeof rawRequest?.followup_to === 'string' && rawRequest.followup_to.trim()
      ? rawRequest.followup_to.trim()
      : null;
    let parent = null;
    if (followupTo) {
      parent = this.jobs.get(followupTo);
      if (!parent) throw new RequestError(`followup_to references unknown job "${followupTo}"`, 'unknown_job');
      if (parent.status !== 'completed') {
        throw new RequestError(
          `followup_to job "${followupTo}" is ${parent.status}; only a completed consultation can be followed up`,
          'followup_not_completed',
        );
      }
    }

    const req = parseRequest(rawRequest, { isFollowup: Boolean(parent) });

    if (parent && parent.target !== req.target) {
      throw new RequestError(
        `follow-up must go to the same consultant as job "${parent.job_id}" (${parent.target})`,
        'followup_target_mismatch',
      );
    }
    const round = parent ? parent.round + 1 : 1;
    if (round > POLICY.maxRounds) {
      throw new RequestError(
        `this consultation has used its ${POLICY.maxRounds} rounds (1 initial + ${POLICY.maxRounds - 1} follow-ups); decide with what you have, or start a new consultation with a materially different question`,
        'round_limit',
      );
    }

    const chainId = parent ? parent.chain_id : id('chain');
    const jobId = id('job');
    const priorRounds = this.#chainHistory(chainId);

    const job = {
      job_id: jobId,
      chain_id: chainId,
      round,
      target: req.target,
      mode: req.mode,
      question: req.question,
      followup_to: followupTo,
      status: 'queued',
      model: POLICY.targets[req.target].model,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      duration_ms: null,
      result: null,
      quality: null,
      usage: null,
      failure: null,
      cancelRequested: false,
      _cancelFns: [],
      _request: req,
    };
    this.jobs.set(jobId, job);
    this.order.push(jobId);
    this.#evict();

    job.promise = this.#execute(job, req, { round, priorRounds }).catch((err) => {
      this.#fail(job, 'cli_error', err?.message ?? String(err));
    });

    return {
      job_id: jobId,
      chain_id: chainId,
      round,
      rounds_remaining: POLICY.maxRounds - round,
      target: req.target,
      mode: req.mode,
      model: job.model,
      status: 'running',
      accepted_at: job.created_at,
      limits: limitsSummary(),
      poll_with: `consult_get({ job_id: "${jobId}", wait_ms: 60000 })`,
    };
  }

  #chainHistory(chainId) {
    return [...this.jobs.values()]
      .filter((j) => j.chain_id === chainId && j.status === 'completed' && j.result)
      .sort((a, b) => a.round - b.round)
      .map((j) => ({
        round: j.round,
        mode: j.mode,
        question: j.question,
        summary: j.result.summary,
        keyPoints: j.result.findings.slice(0, 5).map((f) => f.point),
      }));
  }

  #evict() {
    while (this.order.length > POLICY.maxJobsRetained) {
      const oldest = this.order.shift();
      const j = this.jobs.get(oldest);
      if (j && (j.status === 'running' || j.status === 'queued')) {
        this.order.push(oldest); // never evict live work
        break;
      }
      this.jobs.delete(oldest);
    }
  }

  async #execute(job, req, chain) {
    const adapter = ADAPTERS[req.target];
    const workdir = store.makeWorkdir(job.job_id);
    const text = renderBrief(req, chain);
    const schemaPath = store.writeJobArtifact(job.job_id, 'response-schema.json', JSON.stringify(CONSULT_RESULT_SCHEMA, null, 2));
    const sandbox = adapter.prepareSandbox ? adapter.prepareSandbox({ workdir }) : null;

    try {
      const invocation = adapter.buildInvocation({
        workdir,
        schemaPath,
        guardrails: renderGuardrails(),
        sandbox,
      });

      assertNoForbiddenFlags(req.target, invocation.args);

      const budgetMs = timeoutMs();
      job.status = 'running';
      job.started_at = new Date().toISOString();
      const t0 = Date.now();

      const { handle, done } = runChild({
        command: invocation.command,
        args: invocation.args,
        cwd: workdir,
        env: childEnv(req.target, sandbox?.env ?? {}),
        input: text,
        timeoutMs: budgetMs,
        onCancelSignal: (fn) => job._cancelFns.push(fn),
      });
      job._handle = handle;
      if (job.cancelRequested) handle.stop();

      const run = await done;
      job.duration_ms = Date.now() - t0;
      job.finished_at = new Date().toISOString();

      if (run.spawnError) {
        return this.#fail(job, 'spawn_error', `could not start ${invocation.command}: ${run.spawnError}`);
      }
      if (job.cancelRequested || run.cancelled) {
        return this.#fail(job, 'cancelled', 'consultation cancelled by the lead');
      }
      if (run.timedOut) {
        return this.#fail(job, 'timeout', `consultant exceeded the ${budgetMs} ms budget and was stopped`);
      }

      const lastMessageText = invocation.lastMessagePath ? store.readIfExists(invocation.lastMessagePath) : '';
      const interpreted = adapter.interpret({ ...run, lastMessageText });

      if (!interpreted.ok) {
        job.usage = adapter.usageRecord(interpreted.usageRaw);
        return this.#fail(job, interpreted.failureKind, interpreted.message);
      }

      let normalized;
      try {
        normalized = normalizeResult(interpreted.text);
      } catch (err) {
        if (err instanceof OutputError) {
          job.usage = adapter.usageRecord(interpreted.usageRaw);
          return this.#fail(job, 'invalid_output', err.message, redact(String(err.detail ?? '')).slice(0, 1200));
        }
        throw err;
      }

      job.result = normalized.result;
      job.quality = {
        ...normalized.quality,
        evidence_basis: normalized.result.evidence_basis,
        advice_usable: true,
        caveat: adviceCaveat(normalized),
      };
      job.usage = adapter.usageRecord(interpreted.usageRaw);
      job.status = 'completed';
      this.#finish(job);
      return job;
    } finally {
      sandbox?.cleanup();
    }
  }

  #fail(job, kind, message, detail) {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job;
    job.status = kind === 'cancelled' ? 'cancelled' : 'failed';
    job.failure = {
      kind,
      message: redact(String(message ?? '')).slice(0, 4000),
      detail: detail ?? null,
      retriable: isRetriable(kind),
      delivered_advice: false,
    };
    job.finished_at = job.finished_at ?? new Date().toISOString();
    this.#finish(job);
    return job;
  }

  #finish(job) {
    try { store.persistRound(this.#record(job)); } catch { /* history is best effort */ }
    store.cleanupJobDir(job.job_id);
    job._handle = undefined;
    job._cancelFns = [];
  }

  async wait(jobId, waitMs) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const budget = Math.min(Math.max(0, waitMs ?? 0), POLICY.maxWaitMs);
    if (budget === 0 || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return this.view(jobId);
    }
    await Promise.race([job.promise, new Promise((r) => setTimeout(r, budget).unref?.())]);
    return this.view(jobId);
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status !== 'running' && job.status !== 'queued') {
      return { ...this.view(jobId), cancel_effect: `job was already ${job.status}` };
    }
    job.cancelRequested = true;
    for (const fn of job._cancelFns) fn();
    if (job._handle) job._handle.stop();
    return { ...this.view(jobId), status: 'cancelling', cancel_effect: 'consultant process group signalled' };
  }

  shutdown() {
    for (const job of this.running) {
      job.cancelRequested = true;
      if (job._handle) job._handle.stop();
    }
  }
}

function adviceCaveat(normalized) {
  const { result, quality } = normalized;
  const notes = [];
  if (result.evidence_basis === 'insufficient') {
    notes.push('the consultant reported its evidence as insufficient: treat this as a request for more material, not as advice');
  } else if (result.evidence_basis === 'thin') {
    notes.push('the consultant reported thin evidence: weigh the findings accordingly');
  }
  if (quality.findings_without_grounds > 0) {
    notes.push(`${quality.findings_without_grounds} finding(s) arrived without grounds: do not adopt them without checking`);
  }
  if (quality.unsourced && result.findings.length > 0) {
    notes.push('no sources were cited; the findings rest on the consultant\'s own reasoning over the brief');
  }
  return notes.length ? notes.join('; ') : null;
}

function nextStep(job) {
  if (job.status === 'running' || job.status === 'queued') return 'poll consult_get again, or consult_cancel to stop it';
  if (job.status === 'completed') {
    const left = POLICY.maxRounds - job.round;
    return left > 0
      ? `check the grounds behind the points that matter, then either decide, or spend one of your ${left} remaining round(s) on the specific divergences (followup_to: "${job.job_id}")`
      : 'rounds exhausted: record which points you adopt, reject or hold, and decide';
  }
  if (job.failure?.kind === 'timeout' || job.failure?.kind === 'cli_error') return 'retriable: narrow the brief and start a new consultation';
  if (job.failure?.kind === 'usage_limit' || job.failure?.kind === 'auth') return 'not a consultation outcome: the consultant never answered. Proceed on your own judgement, or fix the credentials/quota first';
  if (job.failure?.kind === 'invalid_output') return 'the consultant answered but not in the required shape; retry once with a shorter brief before giving up';
  return 'proceed on your own judgement and note that no peer input was obtained';
}

export function assertNoForbiddenFlags(target, args) {
  const forbidden = ADAPTERS[target].FORBIDDEN_FLAGS;
  const hit = args.find((a) => forbidden.includes(a));
  if (hit) throw new Error(`refusing to launch consultant with permission-widening flag ${hit}`);
  const workdirIdx = args.indexOf('--add-dir');
  if (workdirIdx !== -1) throw new Error('refusing to widen consultant file access');
  return true;
}
