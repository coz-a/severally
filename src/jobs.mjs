// Job lifecycle: validation, round/concurrency enforcement, child execution,
// classification, history, cancellation.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { POLICY, VERDICTS, limitsSummary, timeoutMs, detectCaller } from './policy.mjs';
import { parseRequest, RequestError } from './schema.mjs';
import { renderBrief, renderGuardrails, briefRecord } from './brief.mjs';
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

// The second way a consultant can be authenticated. A linked token file and an
// API key / ADC file are alternatives, not both required, so the presence of
// either has to satisfy the credential check below. These are the names
// run.mjs deliberately keeps for the antigravity child.
//
// The two shapes are checked differently on purpose. GEMINI_API_KEY and
// GOOGLE_API_KEY carry an opaque string, and a key cannot be validated without
// spending a request, so any non-empty value is taken at face value (an empty
// one is refused). GOOGLE_APPLICATION_CREDENTIALS names a *file*, which can be
// checked: a path to nothing is exactly as unauthenticated as no path at all,
// and counting it would put back the generic "not logged in" this check exists
// to replace.
const API_KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
const CREDENTIAL_FILE_VARS = ['GOOGLE_APPLICATION_CREDENTIALS'];
const ALL_API_CREDENTIAL_VARS = [...API_KEY_VARS, ...CREDENTIAL_FILE_VARS];

function hasApiCredential(env) {
  if (API_KEY_VARS.some((name) => env[name])) return true;
  return CREDENTIAL_FILE_VARS.some((name) => env[name] && fs.existsSync(env[name]));
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

export class JobManager {
  constructor() {
    this.jobs = new Map();
    this.groups = new Map();
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
      group_id: job.group_id,
      round: job.round,
      target: job.target,
      caller: job.caller,
      mode: job.mode,
      status: job.status,
      model: job.model,
      question: job.question,
      brief: job.brief,
      prediction: job.prediction ?? null,
      reflection: job.reflection ?? null,
      record: job.record ?? null,
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
    // While it runs, say what it is doing. "running" for twenty minutes tells
    // the lead nothing; a consultation visibly grinding through tool calls is
    // one it can cancel now rather than wait out.
    rec.progress = job.status === 'running' && job._handle
      ? (ADAPTERS[job.target]?.progress?.({ stdout: job._handle.stdoutSoFar() }) ?? null)
      : null;
    rec.record = job.record ? recordSummary(job) : null;
    rec.prediction = job.prediction ?? null;
    rec.reflection = job.reflection ?? null;
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
          recorded: Boolean(j.record),
          verdicts: j.record ? tally(j.record.entries.map((e) => e.verdict)) : null,
          predicted: Boolean(j.prediction),
          reflected: Boolean(j.reflection),
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

    // Admit or refuse the whole fan-out: a half-started group would leave the
    // lead comparing answers to a question only some consultants were asked.
    if (this.running.length + req.targets.length > POLICY.maxConcurrent) {
      throw new RequestError(
        `this would run ${this.running.length + req.targets.length} consultations at once; the cap is ${POLICY.maxConcurrent}. Wait for one to finish (consult_get) or cancel it`,
        'concurrency_limit',
      );
    }

    const groupId = id('group');
    const members = req.targets.map((target) => {
      const chainId = parent ? parent.chain_id : id('chain');
      const jobId = id('job');
      const job = {
        job_id: jobId,
        chain_id: chainId,
        group_id: groupId,
        round,
        target,
        mode: req.mode,
        // Redacted here, at the one point the request text becomes state:
        // job.question is what reaches the history file on disk and every
        // view. The brief the consultant receives is redacted too
        // (renderBrief), so this is the same text it was actually sent.
        question: redact(req.question),
        brief: briefRecord(req),
        // Written before the consultant is launched and never sent to it. The
        // timestamp is the server's, so the record shows the prediction
        // predates the answer rather than asking anyone to take that on trust.
        prediction: req.prediction
          ? { expected: req.prediction.expected, worry: redact(req.prediction.worry), recorded_at: new Date().toISOString() }
          : null,
        reflection: null,
        caller: req.caller ?? detectCaller(),
        followup_to: followupTo,
        status: 'queued',
        // The model the request asked for, already checked against the
        // operator's allowlist; falls back to the target's default.
        model: req.modelFor?.[target] ?? POLICY.targets[target].model,
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
      return job;
    });
    this.#evict();

    const group = {
      group_id: groupId,
      created_at: new Date().toISOString(),
      mode: req.mode,
      question: members[0].question, // already redacted, and byte-identical across the group
      job_ids: members.map((m) => m.job_id),
    };
    this.groups.set(groupId, group);
    try { store.persistGroup(group); } catch { /* history is best effort */ }

    // One brief, rendered once for the whole group: a fan-out is only comparable
    // if every consultant answered the same question in the same words. Every
    // member shares one chain history by construction -- a fan-out is never a
    // follow-up (parseRequest refuses that), so each member's fresh chain is
    // empty, and a follow-up is always a group of one on the parent's chain.
    const chain = { round, priorRounds: this.#chainHistory(members[0].chain_id) };
    const brief = renderBrief(req, chain);
    for (const job of members) {
      job.promise = this.#execute(job, { ...req, target: job.target }, chain, brief).catch((err) => {
        this.#fail(job, 'cli_error', err?.message ?? String(err));
      });
    }

    const common = {
      group_id: groupId,
      round,
      rounds_remaining: POLICY.maxRounds - round,
      mode: req.mode,
      status: 'running',
      accepted_at: group.created_at,
      limits: limitsSummary(),
    };

    if (!req.fanout) {
      const job = members[0];
      return {
        ...common,
        job_id: job.job_id,
        chain_id: job.chain_id,
        target: job.target,
        model: job.model,
        poll_with: `consult_get({ job_id: "${job.job_id}", wait_ms: 60000 })`,
      };
    }
    return {
      ...common,
      question: group.question, // the redacted text every member was actually sent
      jobs: members.map((m) => ({ job_id: m.job_id, chain_id: m.chain_id, target: m.target, model: m.model })),
      poll_with: `consult_get({ group_id: "${groupId}", wait_ms: 60000 })`,
      note: 'Every consultant got the identical brief. When they come back, compare the grounds behind the points that differ; matching summaries are not evidence of agreement.',
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
      if (j) this.#dropGroupIfEmpty(j.group_id);
    }
  }

  // A group is only a lens onto its member jobs. Once history has evicted the
  // last member there is nothing left to compare, so drop the group rather than
  // keep answering as a complete fan-out with no answers in it (and keep the
  // Map, which holds the question text, from growing without bound).
  #dropGroupIfEmpty(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (group.job_ids.some((jid) => this.jobs.has(jid))) return;
    this.groups.delete(groupId);
  }

  async #execute(job, req, chain, brief) {
    const adapter = ADAPTERS[req.target];
    const workdir = store.makeWorkdir(job.job_id);
    // start() renders the brief once per chain and hands it in, so every member
    // of a fan-out is sent byte-identical text.
    const text = brief ?? renderBrief(req, chain);
    const schemaPath = store.writeJobArtifact(job.job_id, 'response-schema.json', JSON.stringify(CONSULT_RESULT_SCHEMA, null, 2));
    const sandbox = adapter.prepareSandbox ? adapter.prepareSandbox({ workdir }) : null;

    try {
      const env = childEnv(req.target, sandbox?.env ?? {});

      // A sandbox that found no credential to link would otherwise reach the
      // child, which reports whatever generic "not logged in" its vendor
      // emits -- with no hint that peer-consult searched a specific HOME and
      // came back empty. That is exactly the case an operator who has moved
      // their credentials (or set PEER_CONSULT_AGY_CRED_HOME) needs named.
      //
      // But the linked token file and an API key / ADC file are *alternatives*:
      // an operator who authenticates with GEMINI_API_KEY, GOOGLE_API_KEY or
      // GOOGLE_APPLICATION_CREDENTIALS has no token file at all, and that path
      // reached the CLI before this check existed -- run.mjs keeps those
      // variables for exactly that reason. So refuse only when neither
      // mechanism is present, which is a genuinely unauthenticated child. Only
      // the token path has been verified against the live CLI; the API-key
      // path is passed through, not proven.
      //
      // Read from `env`, not process.env: what matters is what the child will
      // actually receive. No test can currently tell the two apart, because
      // childEnv keeps GEMINI_*/GOOGLE_* for the only target that has a
      // sandbox -- so do not "simplify" this to process.env.
      if (sandbox && sandbox.credentials === 'missing' && !hasApiCredential(env)) {
        return this.#fail(
          job,
          'auth',
          `no ${POLICY.targets[req.target].label} credential to hand the consultant: nothing at `
          + `${sandbox.credentialsSource}, and none of ${ALL_API_CREDENTIAL_VARS.join(' / ')} names a `
          + 'usable credential. Log in with that CLI, point PEER_CONSULT_AGY_CRED_HOME at the home '
          + 'directory that holds the token, or set one of those variables to authenticate with an API key '
          + 'instead.',
        );
      }

      const invocation = adapter.buildInvocation({
        workdir,
        schemaPath,
        guardrails: renderGuardrails(),
        sandbox,
        model: job.model,
      });

      assertNoForbiddenFlags(req.target, invocation.args);

      const budgetMs = timeoutMs(req.target);
      job.status = 'running';
      job.started_at = new Date().toISOString();
      const t0 = Date.now();

      const { handle, done } = runChild({
        command: invocation.command,
        args: invocation.args,
        cwd: workdir,
        env,
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
        // A timeout otherwise says nothing about whether the consultant was
        // working or wedged. Adapters that stream their progress can say how
        // far it got, which is what decides between "narrow the brief" and
        // "this one just needs a longer budget".
        const trail = adapter.progress?.(run) ?? null;
        return this.#fail(
          job,
          'timeout',
          `consultant exceeded the ${budgetMs} ms budget and was stopped`,
          trail ? `no answer was produced; it was still working when the budget ran out: ${trail}` : null,
        );
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
      const notes = [adviceCaveat(normalized), sameVendorCaveat(job.caller, req.target)].filter(Boolean);
      // No `advice_usable` verdict here. It was always true, so it carried no
      // information -- and worse, it read as the server vouching for advice it
      // cannot judge. What this server may assert is what it can derive from
      // its own inputs: the consultant's own evidence_basis, how many findings
      // arrived without grounds, whether anything was cited. Whether that adds
      // up to usable advice is the lead's call, made against context the server
      // does not have.
      job.quality = {
        ...normalized.quality,
        evidence_basis: normalized.result.evidence_basis,
        caveat: notes.length ? notes.join('; ') : null,
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

  // The lead's own column: what they checked, what it turned out to be, and
  // what it changed. Nothing here is inferred -- the server refuses an id the
  // consultant did not produce and a word outside VERDICTS, then stores what
  // was written. It never decides that a finding was adopted, and it never
  // fills in a verdict the lead did not write.
  record(input = {}) {
    const allowed = ['job_id', 'entries', 'reflection'];
    const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
    if (unknown.length) {
      throw new RequestError(
        `${unknown.map((k) => `"${k}"`).join(', ')} cannot be written here; this call takes ${allowed.join(', ')}`
        + (unknown.includes('prediction')
          ? '. A prediction is written when the consultation starts (consult_start\'s `prediction`) and cannot be added or changed afterwards -- that is what makes it a prediction'
          : ''),
        'unknown_field',
      );
    }
    const { job_id: jobId, entries, reflection } = input;
    if (entries === undefined && reflection === undefined) {
      throw new RequestError('pass entries (verdicts on specific points), reflection (what the answer added), or both', 'nothing_to_record');
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new RequestError(
        `no consultation with job_id "${jobId}" in this session (job ids are lost when the client restarts; the round file under ~/.peer-consult/history keeps the answer)`,
        'unknown_job',
      );
    }
    if (!job.result) {
      throw new RequestError(
        `consultation "${jobId}" is ${job.status} and produced no advice, so there is nothing to record a verdict against`,
        'no_result',
      );
    }
    if (entries !== undefined && (!Array.isArray(entries) || entries.length === 0)) {
      throw new RequestError('entries must be a non-empty array of { id, verdict, effect?, note? }', 'entries_required');
    }

    const ids = recordableIds(job.result);
    const now = new Date().toISOString();
    const merged = new Map((job.record?.entries ?? []).map((e) => [e.id, e]));

    for (const entry of entries ?? []) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!ids.includes(id)) {
        throw new RequestError(
          `"${id}" is not a point in this answer; record against one of: ${ids.join(', ')}`,
          'unknown_entry_id',
        );
      }
      const verdict = typeof entry?.verdict === 'string' ? entry.verdict.trim() : '';
      if (!VERDICTS.includes(verdict)) {
        throw new RequestError(
          `verdict for "${id}" must be one of: ${VERDICTS.join(', ')} -- these describe what checking the point showed, not whether you adopted it`,
          'invalid_verdict',
        );
      }
      merged.set(id, {
        id,
        verdict,
        effect: text(entry?.effect),
        note: text(entry?.note),
        recorded_at: now,
      });
    }

    // What the answer added over what the lead already expected, in the lead's
    // own words. Deliberately free text with no hit/miss label: a point the
    // lead predicted can still arrive with the evidence that settles it, and a
    // surprise can still be wrong, so a match/miss verdict would rate the
    // consultation on the wrong axis.
    if (reflection !== undefined) {
      const delta = text(reflection?.delta);
      if (!delta) {
        throw new RequestError('reflection.delta must say what the answer added, or that it added nothing', 'delta_required');
      }
      const related = Array.isArray(reflection?.related_item_ids) ? reflection.related_item_ids : [];
      for (const id of related) {
        if (!ids.includes(id)) {
          throw new RequestError(
            `"${id}" is not a point in this answer; relate the reflection to one of: ${ids.join(', ')}`,
            'unknown_entry_id',
          );
        }
      }
      job.reflection = { delta, related_item_ids: related, recorded_at: now };
    }

    if (entries !== undefined) {
      job.record = {
        updated_at: now,
        entries: ids.filter((id) => merged.has(id)).map((id) => merged.get(id)),
      };
    }
    // An update to a round that already happened, so the index line stays as it
    // was: the history has one line per consultation, not one per edit.
    try { store.persistRound(this.#record(job), { appendIndex: false }); } catch { /* history is best effort */ }

    return {
      job_id: job.job_id,
      chain_id: job.chain_id,
      round: job.round,
      record: job.record ? recordSummary(job) : null,
      prediction: job.prediction ?? null,
      reflection: job.reflection ?? null,
    };
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

  // Every field here is derived from the one `members` array it is handed, so a
  // group view can never report one status in `members` and another in
  // `comparison` or `status` for the same job.
  #shapeGroup(group, members) {
    const cancelling = members.some((m) => m.status === 'cancelling');
    const live = cancelling || members.some((m) => m.status === 'running' || m.status === 'queued');
    const missing = group.job_ids.length - members.length;
    // "Nothing live" is not the same as "there is something to compare": a
    // group whose every member failed or was cancelled lands here too, and
    // telling the lead to compare divergences between zero answers invites
    // exactly the "the consultants had no concerns" summary that a failure
    // must never be turned into.
    const anyResult = members.some((m) => m.result);
    return {
      group_id: group.group_id,
      status: cancelling ? 'cancelling' : (live ? 'running' : 'done'),
      mode: group.mode,
      question: group.question,
      members_expected: group.job_ids.length,
      members_available: members.length,
      // History is capped, so an older member can already be gone. Say so:
      // a fan-out that quietly reports fewer answers than it asked for is
      // worse than one that admits the comparison is partial.
      incomplete_note: missing > 0
        ? `${missing} of ${group.job_ids.length} member consultation(s) have aged out of this session's history; the comparison below is partial`
        : null,
      members,
      comparison: comparison(members),
      cancellable: live,
      next_step: cancelling
        ? 'poll consult_get with this group_id until every member reads cancelled'
        : live
          ? 'poll consult_get again with this group_id, or consult_cancel it'
          : anyResult
            ? 'list the points where the consultants diverge, check the grounds behind each one, then spend a follow-up (followup_to on that member job) only on a divergence that would change your decision'
            : 'no advice was obtained: no member of this fan-out produced a result (see each member\'s failure.kind). Say so plainly -- this is not "the consultants had no concerns" -- and proceed on your own judgement',
      limits: limitsSummary(),
    };
  }

  groupView(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    return this.#shapeGroup(group, group.job_ids.map((jid) => this.view(jid)).filter(Boolean));
  }

  async waitGroup(groupId, waitMs) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const budget = Math.min(Math.max(0, waitMs ?? 0), POLICY.maxWaitMs);
    if (budget > 0) {
      const promises = group.job_ids.map((jid) => this.jobs.get(jid)?.promise).filter(Boolean);
      await Promise.race([
        Promise.all(promises),
        new Promise((r) => setTimeout(r, budget).unref?.()),
      ]);
    }
    return this.groupView(groupId);
  }

  cancelGroup(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    // Count what is actually about to be signalled before signalling it:
    // cancel() short-circuits on a member that has already finished, so a
    // blanket "everyone was signalled" would be a false report on a done group.
    const signalled = group.job_ids.filter((jid) => {
      const j = this.jobs.get(jid);
      return j && (j.status === 'running' || j.status === 'queued');
    }).length;
    // Shape the view from the cancel() results, not from a fresh read: the
    // children exit asynchronously, so a signalled member reads as
    // "cancelling" until it is reaped, and the whole payload must say so.
    const members = group.job_ids.map((jid) => this.cancel(jid)).filter(Boolean);
    const total = group.job_ids.length;
    return {
      ...this.#shapeGroup(group, members),
      cancel_effect: signalled === 0
        ? 'nothing to signal: every consultant in this fan-out had already finished'
        : signalled === total
          ? 'every consultant process group in this fan-out was signalled'
          : `${signalled} of ${total} consultant process groups in this fan-out were signalled; the rest had already finished`,
    };
  }

  shutdown() {
    for (const job of this.running) {
      job.cancelRequested = true;
      if (job._handle) job._handle.stop();
    }
  }
}

// The points a verdict can name, in the order they appear in the answer.
function recordableIds(result) {
  return [
    ...result.findings.map((f) => f.id),
    ...result.unknowns.map((u) => u.id),
    ...result.next_checks.map((c) => c.id),
  ].filter(Boolean);
}

// How many of each word, in the order they first appear. The only arithmetic
// this server does on anyone's judgement.
function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

// Counting is mechanical and stays that way: how many points the answer has,
// how many carry a verdict, which ones do not. No judgement about whether the
// consultation was worth it -- that is the lead's to draw from the entries.
function recordSummary(job) {
  const ids = recordableIds(job.result);
  const written = new Set(job.record.entries.map((e) => e.id));
  return {
    ...job.record,
    verdicts: tally(job.record.entries.map((e) => e.verdict)),
    coverage: { recordable: ids.length, recorded: written.size },
    unrecorded: ids.filter((id) => !written.has(id)),
  };
}

function text(value) {
  if (typeof value !== 'string') return null;
  const t = redact(value).trim();
  if (!t) return null;
  return t.length > POLICY.output.itemTextMax ? `${t.slice(0, POLICY.output.itemTextMax)}\n…[truncated by peer-consult]` : t;
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

// A lead may legitimately name its own CLI as the consultant: a fresh child
// session with no shared context is still a useful clean-context re-read.
// But it is not an independent opinion -- the answer comes from the same
// vendor's model family -- so flag it rather than let it pass as one.
function sameVendorCaveat(caller, target) {
  if (!caller || !POLICY.targets[caller] || !POLICY.targets[target]) return null;
  if (POLICY.targets[caller].vendor !== POLICY.targets[target].vendor) return null;
  // Say what a fresh session of the same lineage removes and what it keeps.
  // The earlier wording ("prefer the other two") was read, in live runs, as a
  // verdict on the answer: leads filed this consultant's findings under
  // Rejected without checking their grounds.
  return `the consultant runs the same vendor's model family as you (${POLICY.targets[target].vendor}). A fresh session removes what your own session accumulated — history, sunk cost, drift toward your framing — but not what the lineage shares: training-data blind spots and the same reflexes toward this brief's wording. Weigh it as a fresh-context re-read rather than an independent opinion; that is not a reason to skip checking its grounds like any other answer`;
}

// A mechanical side-by-side. The server deliberately does not decide whether
// the consultants agree: inventing agreement that is not there is exactly the
// failure a second opinion is supposed to prevent.
function comparison(members) {
  return {
    by_target: members.map((m) => ({
      target: m.target,
      status: m.status,
      failure_kind: m.failure?.kind ?? null,
      // Declared by the consultant, relayed unjudged. In live runs, leads that
      // saw two consultants share a finding read them as agreeing, when their
      // bottom lines were opposite; one word per consultant makes that
      // visible without the server interpreting anyone's summary.
      stance: m.result?.stance ?? null,
      confidence: m.result?.confidence ?? null,
      evidence_basis: m.result?.evidence_basis ?? null,
      summary: m.result?.summary ?? null,
      finding_points: (m.result?.findings ?? []).map((f) => f.point),
      // How heavy this consultant said its own findings were, and what it said
      // would change its mind. Both were already in the per-member result and
      // both were being lost in the one view built for reading two answers
      // against each other -- the place where "they broadly agree" gets written.
      // Counted and relayed, never compared: two consultants naming the same
      // condition is for the lead to notice, not for the server to assert.
      severity_counts: tally((m.result?.findings ?? []).map((f) => f.severity ?? 'unrated')),
      decision_changers: m.result?.decision_changers ?? [],
      alternative_options: (m.result?.alternatives ?? []).map((a) => a.option),
      unknowns: (m.result?.unknowns ?? []).map((u) => u.item),
      remaining_disagreements: m.result?.remaining_disagreements ?? [],
    })),
    note:
      'This server does not judge whether the consultants agree: similar summaries are not evidence of agreement. ' +
      'Each stance is the consultant\'s own declaration, relayed as given -- consultants that share a finding can still ' +
      'declare opposite stances, and that is a divergence. Compare the grounds behind each point yourself, and spend a ' +
      'follow-up only where a divergence would change your decision.',
  };
}

function nextStep(job) {
  if (job.status === 'running' || job.status === 'queued') return 'poll consult_get again, or consult_cancel to stop it';
  if (job.status === 'completed') {
    const left = POLICY.maxRounds - job.round;
    // A consultation is finished when the lead has said what checking each
    // point showed, not when the answer arrives. Name the open ones until then.
    const written = new Set((job.record?.entries ?? []).map((e) => e.id));
    const open = job.result ? recordableIds(job.result).filter((id) => !written.has(id)).length : 0;
    const close = open > 0
      ? ` Then write what checking showed: consult_record({ job_id: "${job.job_id}", entries: [{ id, verdict, effect }] }) -- ${open} point(s) still carry no verdict.`
      : '';
    return (left > 0
      ? `check the grounds behind the points that matter, then either decide, or spend one of your ${left} remaining round(s) on the specific divergences (followup_to: "${job.job_id}").`
      : 'rounds exhausted: decide with what you have.') + close;
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
