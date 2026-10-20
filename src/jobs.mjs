// Job lifecycle: validation, round/concurrency enforcement, child execution,
// classification, history, cancellation.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { POLICY, VERDICTS, limitsSummary, timeoutMs, detectCaller, configProblem, consultantByName, consultantAvailable } from './policy.mjs';
import { vendorOf, sameModel, CLI_VENDORS } from './consultants.mjs';
import { parseRequest, RequestError, charCount } from './schema.mjs';
import { renderBrief, renderGuardrails, briefRecord } from './brief.mjs';
import { CONSULT_RESULT_SCHEMA } from './result-schema.mjs';
import { normalizeResult, OutputError } from './parse-result.mjs';
import { redact } from './redact.mjs';
import { isRetriable, AUTO_RETRY_KINDS } from './failures.mjs';
import { childEnv, operatorEnvProblem, runChild } from './run.mjs';
import * as store from './store.mjs';
import { materializeExposedPaths, exposeDiff, planInheritance, reexposeChange } from './expose-paths.mjs';
import * as codex from './adapters/codex.mjs';
import * as claudeCode from './adapters/claude-code.mjs';
import * as antigravity from './adapters/antigravity.mjs';
import * as opencode from './adapters/opencode.mjs';

const ADAPTERS = { codex, 'claude-code': claudeCode, antigravity, opencode };

// The recovery respawn runs only while this much of the original budget is
// still left: below it a retry cannot produce a real answer, and granting it
// anyway would silently extend the job's advertised wall-clock deadline.
const MIN_RETRY_MS = 5_000;

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

// The figures every adapter's usageRecord names; one a CLI never reports is
// listed as not reported rather than silently missing from the totals.
const USAGE_FIGURES = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens', 'cost_usd'];

const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// Jobs this process is running, across every JobManager in it. A marker owned
// by this pid but missing here was left by an earlier process that had the
// same pid, so it is as dead as one whose pid no longer exists.
const LIVE_HERE = new Set();

// What became of the process that started a consultation: 'alive', 'dead',
// or 'overdue' -- its pid still exists but the job is past its deadline
// (budget, retries included, plus the kill grace), so either that process is
// stuck or the pid now belongs to something else. Nothing is killed on the
// strength of this.
function ownerState(jobId, owner) {
  if (!owner) return 'dead';
  let pidAlive;
  if (owner.pid === process.pid) pidAlive = LIVE_HERE.has(jobId);
  else try { process.kill(owner.pid, 0); pidAlive = true; } catch (err) { pidAlive = err.code === 'EPERM'; }
  if (!pidAlive) return 'dead';
  return Date.now() > Date.parse(owner.deadline_at) ? 'overdue' : 'alive';
}

export class JobManager {
  constructor() {
    this.jobs = new Map();
    this.groups = new Map();
    this.order = [];
    store.ensureDirs();
  }

  // A consultation this process does not hold: finished (its round file), or
  // still in progress (its marker). A marker whose owner is gone becomes a
  // failed round, `interrupted`, written once by whichever process claims it.
  #fromDisk(jobId) {
    const done = store.loadRound(jobId);
    if (done) return done;
    const live = store.loadRunning(jobId);
    // Its owner may have finished between the two reads: the round is there now.
    if (!live) return store.loadRound(jobId);
    const state = ownerState(jobId, live.owner);
    return state === 'alive' ? live : this.#interrupt(jobId, live, state);
  }

  // Every step is safe to repeat, so a process that dies part-way leaves
  // something the next reader finishes: the round is written (the index
  // takes it once), then the marker goes. A round already on disk wins -- its
  // owner finished and died before removing the marker.
  #interrupt(jobId, rec, state) {
    const done = store.loadRound(jobId);
    if (done) { store.removeRunning(jobId); return done; }
    const { owner, ...round } = rec;
    round.status = 'failed';
    round.finished_at = new Date().toISOString();
    round.failure = {
      kind: 'interrupted',
      message: `the severally process that ran this consultation (pid ${owner?.pid}) exited before it finished`,
      detail: null,
      retriable: true,
      delivered_advice: false,
    };
    try { store.persistRound(round); } catch { return round; }
    store.removeRunning(jobId);
    // An overdue owner may still be running its consultant: leave its working
    // directory to it. ponytail: if the pid was reused instead, that
    // directory stays behind until removed by hand.
    if (state === 'dead') store.cleanupJobDir(jobId);
    return round;
  }

  /** Close out the consultations whose process died, and remove their job directories. */
  sweepInterrupted() {
    for (const jobId of store.listRunning()) {
      const rec = store.loadRunning(jobId);
      const state = rec && ownerState(jobId, rec.owner);
      if (rec && state !== 'alive') this.#interrupt(jobId, rec, state);
    }
  }

  #diskView(rec) {
    const elsewhere = Boolean(rec.owner);
    const { owner, ...view } = rec;
    return {
      ...view,
      cancellable: false,
      progress: null,
      record: view.record ? recordSummary(view) : null,
      brief: elsewhere ? null : view.brief,
      limits: elsewhere ? null : limitsSummary(),
      next_step: elsewhere
        ? `running in another severally process (pid ${owner.pid}); poll again later -- it can only be cancelled from that process`
        : nextStep(view),
    };
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
      cli: job.cli,
      vendor: job.vendor ?? null,
      caller: job.caller,
      caller_model: job.caller_model ?? null,
      initiator: job.initiator ?? null,
      network: job.network ?? 'on',
      boundary: job.boundary ?? null,
      retries: job.retries ?? [],
      partial_output: job.partial_output ?? null,
      tool_calls: job.tool_calls ?? null,
      diagnostics: job.diagnostics ?? null,
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

  // `detail: "full"` returns the brief as stored; by default a finished
  // consultation names it (size, sha256, round file) instead of repeating it.
  view(jobId, { detail } = {}) {
    const job = this.jobs.get(jobId);
    if (!job) {
      const rec = this.#fromDisk(jobId);
      return rec ? compactBrief(this.#diskView(rec), detail) : null;
    }
    const rec = this.#record(job);
    rec.cancellable = job.status === 'running' || job.status === 'queued';
    // While it runs, say what it is doing. "running" for twenty minutes tells
    // the lead nothing; a consultation visibly grinding through tool calls is
    // one it can cancel now rather than wait out.
    rec.progress = job.status === 'running' && job._handle
      ? (ADAPTERS[job.cli]?.progress?.({ stdout: job._handle.stdoutSoFar() }) ?? null)
      : null;
    rec.record = job.record ? recordSummary(job) : null;
    rec.prediction = job.prediction ?? null;
    rec.reflection = job.reflection ?? null;
    // A consultation is polled several times before it answers, and the brief
    // is the largest thing in this payload. Echoing it back on every poll
    // spends the lead's context on the one thing it wrote itself moments ago,
    // and a fan-out multiplies that by the number of consultants. It comes
    // back with the answer, which is when it is worth re-reading.
    // The limits went out with consult_start and do not change mid-run, so
    // they come back with the answer, not on every poll.
    const live = job.status === 'running' || job.status === 'queued' || job.status === 'cancelling';
    if (live) {
      rec.brief = null;
      rec.brief_note = 'omitted while the consultation is running; returned once it finishes, and kept in ~/.severally/history either way';
    }
    rec.limits = live ? null : limitsSummary();
    rec.next_step = nextStep(job);
    return compactBrief(rec, detail);
  }

  // This session's consultations and the history's, so an earlier session's
  // job_id and group_id can still be followed up and recorded against. The
  // index only picks and orders; each row shown is read from its round, which
  // holds the verdicts written since. Memory wins over disk for the same job.
  list({ limit = 20 } = {}) {
    const here = this.order.map((jid) => this.jobs.get(jid));
    const seen = new Set(here.map((j) => j.job_id));
    const elsewhere = [];
    for (const jobId of store.listRunning()) {
      if (seen.has(jobId)) continue;
      const rec = this.#fromDisk(jobId);
      if (rec) { seen.add(jobId); elsewhere.push({ rec }); }
    }
    for (const row of store.indexRows()) if (!seen.has(row.job_id)) { seen.add(row.job_id); elsewhere.push({ row }); }
    const at = (x) => x.created_at ?? x.rec?.created_at ?? x.row?.created_at ?? '';
    const picked = [];
    // Round files are read only for the rows shown; one that cannot be read is passed over.
    for (const x of [...here, ...elsewhere].sort((p, q) => (at(q) < at(p) ? -1 : at(q) > at(p) ? 1 : 0))) {
      if (picked.length >= limit) break;
      const j = x.row ? store.loadRoundAt(x.row) : x.rec ?? x;
      if (j) picked.push(j);
    }
    return picked
      .map((j) => {
        return {
          job_id: j.job_id,
          group_id: j.group_id ?? null,
          chain_id: j.chain_id,
          round: j.round,
          target: j.target,
          cli: j.cli,
          model: j.model,
          mode: j.mode,
          status: j.status,
          failure_kind: j.failure?.kind ?? null,
          created_at: j.created_at,
          duration_ms: j.duration_ms,
          summary: j.result ? j.result.summary.slice(0, 200) : null,
          recorded: Boolean(j.record),
          verdicts: j.record?.entries ? tally(j.record.entries.map((e) => e.verdict)) : null,
          this_session: this.jobs.has(j.job_id),
          predicted: Boolean(j.prediction),
          reflected: Boolean(j.reflection),
          initiator: j.initiator ?? null,
        };
      });
  }

  /**
   * Usage summed per consultant over this session's consultations, every
   * attempt included (a re-run spends quota too): only the figures each CLI
   * reported are added, so a figure a CLI leaves null is not counted as zero
   * but named under `not_reported`. Nothing is estimated.
   */
  usageTotals() {
    const by = {};
    const reported = {};
    for (const j of this.jobs.values()) {
      const attempts = [...(j.retries ?? []).map((r) => r.usage), j.usage].filter(Boolean);
      if (!attempts.length) continue;
      const t = (by[j.target] ??= { consultations: 0, attempts: 0 });
      const seen = (reported[j.target] ??= new Set());
      t.consultations += 1;
      t.attempts += attempts.length;
      for (const u of attempts) {
        for (const [k, v] of Object.entries(u)) if (typeof v === 'number') { t[k] = (t[k] ?? 0) + v; seen.add(k); }
      }
    }
    for (const [target, t] of Object.entries(by)) {
      t.not_reported = USAGE_FIGURES.filter((k) => !reported[target].has(k));
    }
    return by;
  }

  start(rawRequest) {
    if (process.env.SEVERALLY_ACTIVE === '1') {
      throw new RequestError(
        'this process is itself running as a peer consultant; nested consultations are not allowed',
        'recursion_blocked',
      );
    }
    // A config the operator got wrong is not run on defaults: that could
    // re-enable a CLI they turned off. Reading the history still works.
    if (configProblem()) throw new RequestError(`the severally config file needs fixing first: ${configProblem()}`, 'config_invalid');

    // Resolve the chain before validating, so follow-up rules can be applied.
    const followupTo = typeof rawRequest?.followup_to === 'string' && rawRequest.followup_to.trim()
      ? rawRequest.followup_to.trim()
      : null;
    let parent = null;
    let fromGroup = null;
    if (followupTo?.startsWith('group_')) {
      // A follow-up to a fan-out goes to every member that can take one; the
      // members are the targets, so the request names none.
      if ((rawRequest.target ?? null) !== null || rawRequest.targets?.length) {
        throw new RequestError(
          'a follow-up to a group goes to every member that can take one, so leave target and targets out; to follow up one member, pass its job_id',
          'followup_group_targets',
        );
      }
      fromGroup = this.#groupParents(followupTo);
      rawRequest = { ...rawRequest, targets: fromGroup.links.map((l) => l.parent.target) };
    } else if (followupTo) {
      // A job from an earlier server session is read back from the history,
      // so a restart does not end a consultation the lead is still checking.
      parent = this.jobs.get(followupTo) ?? store.loadRound(followupTo);
      if (!parent) throw new RequestError(`followup_to references unknown job "${followupTo}"`, 'unknown_job');
      if (parent.status !== 'completed') {
        throw new RequestError(
          `followup_to job "${followupTo}" is ${parent.status}; only a completed consultation can be followed up`,
          'followup_not_completed',
        );
      }
      // Only the newest answer of a chain can be followed up, and the new
      // round goes after every round already there: numbering it parent + 1
      // would overwrite a later round's history file. A later round that
      // failed or was cancelled does not block a retry from the parent.
      const rounds = this.#chainRounds(parent.chain_id);
      const later = rounds.find((j) => j.round > parent.round && !['failed', 'cancelled'].includes(j.status));
      if (later) {
        throw new RequestError(
          `job "${followupTo}" is round ${parent.round}, and this consultation already has round ${later.round} (job "${later.job_id}", ${later.status}); follow up the latest round`,
          'followup_not_latest',
        );
      }
      parent = { ...parent, nextRound: Math.max(...rounds.map((j) => j.round)) + 1 };
    }

    if (parent && (rawRequest.target ?? null) === null && !rawRequest.targets?.length) {
      rawRequest = { ...rawRequest, target: parent.target };
    }
    // A fan-out's members were all handed the same brief, so any one of them holds it.
    if (parent || fromGroup) rawRequest = inherit(rawRequest, fromGroup ? fromGroup.links[0].groupMember ?? fromGroup.links[0].parent : parent);

    const req = parseRequest(rawRequest, {
      isFollowup: Boolean(parent || fromGroup),
      parentMode: parent?.mode ?? fromGroup?.group.mode ?? null,
      groupFollowup: Boolean(fromGroup),
    });
    // The operator's setting only ever closes: a request cannot reopen the web.
    if (POLICY.network === 'off') req.network = 'off';

    if (fromGroup && fromGroup.links.some((l, i) => l.parent.target !== req.targets[i])) {
      throw new RequestError(
        `the members of group "${followupTo}" no longer resolve to the consultants that answered them; follow up each member by its job_id`,
        'followup_target_mismatch',
      );
    }
    if (parent && parent.target !== req.target) {
      throw new RequestError(
        `follow-up must go to the same consultant as job "${parent.job_id}" (${parent.target})`,
        'followup_target_mismatch',
      );
    }
    const round = parent ? parent.nextRound : 1;
    if (!fromGroup && round > POLICY.maxRounds) {
      throw new RequestError(
        `this consultation has used its ${POLICY.maxRounds} rounds (1 initial + ${POLICY.maxRounds - 1} follow-ups); decide with what you have, or start a new consultation with a materially different question`,
        'round_limit',
      );
    }

    // Admit or refuse the whole fan-out: a half-started group would leave the
    // lead comparing answers to a question only some consultants were asked.
    // The cap counts every severally process on this home, through the seats.
    // A follow-up's seat also names the chain and round it opens, so that two
    // servers continuing one consultation at once cannot both take a round
    // number: neither sees the other's round in its history until it ends.
    const chainOf = (i) => (fromGroup ? fromGroup.links[i] : parent ? { parent, round } : null);
    const seats = req.targets.map((target, i) => ({
      job_id: id('job'),
      ...(chainOf(i) ? { chain_id: chainOf(i).parent.chain_id, round: chainOf(i).round } : {}),
      // Twice the budget plus an hour: the deadline is wall-clock, the budget is
      // not, so a suspended laptop must not make a live owner look overdue.
      owner: {
        pid: process.pid,
        deadline_at: new Date(Date.now() + 2 * timeoutMs(consultantByName(target)) + POLICY.killGraceMs + 3_600_000).toISOString(),
      },
    }));
    const taken = store.takeSeats(seats, POLICY.maxConcurrent, (seat) => ownerState(seat.job_id, seat.owner) === 'alive');
    if (taken.chainBusy) {
      const { live, mine } = taken.chainBusy;
      throw new RequestError(
        `another severally process has already continued this consultation: job "${live.job_id}" is round ${live.round ?? mine.round}`
        + '; wait for it (consult_get) and follow up the latest round',
        'followup_not_latest',
      );
    }
    if (!taken.ok) {
      throw new RequestError(
        `this would run ${taken.live + seats.length} consultations at once; the cap is ${POLICY.maxConcurrent}`
        + (taken.elsewhere ? `, and ${taken.elsewhere} of the ${taken.live} running are in other severally processes` : '')
        + '. Wait for one to finish (consult_get) or cancel it',
        'concurrency_limit',
      );
    }
    // A request refused from here on gives its seats back.
    try {
      // Each target's parent round and the round it opens, in req.targets order.
      const links = fromGroup?.links ?? req.targets.map(() => ({ parent, round }));
      return this.#admitted(req, links, seats, fromGroup);
    } catch (err) {
      for (const seat of seats) if (!this.jobs.has(seat.job_id)) store.releaseSeat(seat.job_id);
      throw err;
    }
  }

  // A follow-up to a fan-out: each member goes on from the newest answered
  // round of its own chain. A member that is still running, never answered or
  // has used its rounds is skipped and named; if that is every member, the
  // request is refused.
  #groupParents(groupId) {
    const group = this.groups.get(groupId) ?? store.loadGroup(groupId);
    if (!group) throw new RequestError(`followup_to references unknown group "${groupId}"`, 'unknown_group');
    const links = [];
    const skipped = [];
    for (const jid of group.job_ids) {
      const member = this.jobs.get(jid) ?? store.loadRound(jid);
      if (!member) {
        skipped.push({ job_id: jid, target: null, reason: 'not found: aged out of the history, or still running in another severally process' });
        continue;
      }
      const rounds = this.#chainRounds(member.chain_id);
      const latest = rounds.filter((j) => !['failed', 'cancelled'].includes(j.status)).sort((a, b) => b.round - a.round)[0];
      const nextRound = Math.max(...rounds.map((j) => j.round)) + 1;
      // The name is kept, not re-resolved: a consultant renamed or turned off
      // since is skipped, never continued by whichever one answers to it now.
      const consultant = consultantByName(member.target);
      const reason = !latest ? `${member.status}, so there is no answer to follow up`
        : latest.status !== 'completed' ? `round ${latest.round} is still ${latest.status}`
          : nextRound > POLICY.maxRounds ? `has used its ${POLICY.maxRounds} rounds`
            : !consultant || !consultantAvailable(consultant) ? 'this consultant is no longer configured or available here'
              : null;
      if (reason) skipped.push({ job_id: (latest ?? member).job_id, target: member.target, reason });
      else links.push({ parent: { ...latest, nextRound }, round: nextRound, groupMember: member });
    }
    if (!links.length) {
      throw new RequestError(
        `no member of group "${groupId}" can take a follow-up: ${skipped.map((x) => `${x.target ?? x.job_id} (${x.reason})`).join(', ')}`,
        'followup_nothing_to_continue',
      );
    }
    return { group, links, skipped };
  }

  #admitted(req, links, seats, fromGroup = null) {
    // What expose_from_parent copies again: for a group, what that fan-out
    // exposed (one manifest, shared by its members); otherwise the parent's.
    const parent = links[0].groupMember ?? links[0].parent;
    const groupId = id('group');
    // Copied once for the whole request, before a round is counted or a job
    // exists, into the group's own directory: every member is then handed the
    // same bytes (the manifest carries their sha256), and a path that is
    // missing or a tree that blows the cap is the lead's to fix now rather
    // than a job that fails having already spent a round of this chain.
    let exposeManifest = null;
    const parentEntries = req.context.expose_from_parent ? parent.brief?.expose_paths?.entries ?? [] : [];
    if (req.context.expose_from_parent && parentEntries.length === 0) {
      throw new RequestError(
        `context.expose_from_parent: job "${parent.job_id}" exposed no files, so there is nothing to copy again; name them in context.expose_paths`,
        'nothing_to_inherit',
      );
    }
    if (req.context.expose_paths.length > 0 || req.context.expose_diff || parentEntries.length > 0) {
      const snapshot = store.jobDir(groupId);
      try {
        fs.mkdirSync(path.join(snapshot, 'workspace'), { recursive: true, mode: 0o700 });
        const plan = planInheritance(parentEntries, req.context.expose_paths);
        exposeManifest = materializeExposedPaths(snapshot, plan.paths)
          ?? { entries: [], totals: { files: 0, bytes: 0 }, skipped: [] };
        exposeManifest.skipped.push(...plan.skipped);
        const parentSources = new Set(parentEntries.map((e) => e.source));
        for (const e of exposeManifest.entries) if (parentSources.has(e.source)) e.inherited = true;
        // The files the parent's change touched are copied as they are now --
        // unless this call gives a diff of its own, which is taken fresh
        // instead, and the earlier change is named as replaced.
        for (const d of plan.diffs) {
          if (req.context.expose_diff) {
            exposeManifest.skipped.push({ source: d.source, reason: 'replaced', exposed_as: d.exposed_as });
          } else {
            if (reexposeChange(snapshot, d, exposeManifest)) exposeManifest.entries.at(-1).inherited = true;
          }
        }
        if (req.context.expose_diff) {
          const room = Math.min(POLICY.input.artifactExcerptMax, POLICY.input.totalCharsMax - charCount(req));
          const diff = exposeDiff(snapshot, req.context.expose_diff, exposeManifest, room);
          if (diff) {
            req.context.artifacts = [...req.context.artifacts,
              { name: `git diff ${exposeManifest.entries.at(-1).base}`, kind: 'diff', language: 'diff', excerpt: diff }];
          }
        }
        markSinceParent(exposeManifest, parentEntries);
        // Every earlier path gone, and nothing else to go on: refused, as a
        // first round with no context is.
        if (parentEntries.length && !exposeManifest.entries.length && !req.context.facts.length && !req.context.artifacts.length) {
          throw new RequestError(
            `context.expose_from_parent: nothing job "${parent.job_id}" exposed is there any more, and this request has no facts or artifacts`,
            'nothing_to_inherit',
          );
        }
      } catch (err) {
        store.cleanupJobDir(groupId);
        if (err instanceof RequestError || !err.code) throw err;
        throw new RequestError(err.message, err.code === 'too_large' ? 'expose_paths_too_large' : 'expose_path_invalid');
      }
      req._snapshot = path.join(snapshot, 'workspace');
    }
    const members = req.targets.map((target, i) => {
      const { parent: from, round } = links[i];
      const chainId = from ? from.chain_id : id('chain');
      const jobId = seats[i].job_id;
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
        brief: briefRecord(req, exposeManifest),
        // Written before the consultant is launched and never sent to it. The
        // timestamp is the server's, so the record shows the prediction
        // predates the answer rather than asking anyone to take that on trust.
        prediction: req.prediction
          ? { expected: req.prediction.expected, worry: redact(req.prediction.worry), recorded_at: new Date().toISOString() }
          : null,
        reflection: null,
        caller: req.caller ?? detectCaller(),
        // Declared by the lead, never checked: the server cannot see what
        // model the host CLI runs. Kept so the record says who asked whom.
        caller_model: req.caller_model ?? null,
        // Also declared by the lead: whether the user asked for this. Nothing
        // reads it but the record.
        initiator: req.initiator ?? null,
        network: req.network,
        boundary: null,
        retries: [],
        partial_output: null,
        tool_calls: null,
        followup_to: from?.job_id ?? null,
        status: 'queued',
        // What this consultant is: the CLI it runs on, the model and its
        // lineage, as the operator defined it.
        cli: consultantByName(target).cli,
        model: consultantByName(target).model,
        vendor: consultantByName(target).vendor,
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
      LIVE_HERE.add(jobId);
      job._owner = seats[i].owner;
      this.#mark(job);
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

    // A fan-out is only comparable if every consultant answered the same
    // question in the same words: every member's brief is the same request,
    // rendered the same way. Only the earlier rounds differ -- each member's
    // own, on a follow-up to a group; none, on a first round.
    for (const job of members) {
      const chain = { round: job.round, priorRounds: this.#chainHistory(job.chain_id) };
      const brief = renderBrief(req, chain, exposeManifest);
      job.promise = this.#execute(job, { ...req, target: job.target }, chain, brief).catch((err) => {
        this.#fail(job, 'cli_error', err?.message ?? String(err));
      });
    }
    // Every member copied the snapshot into its own workspace before its
    // first await (#execute), so it can go now: nothing outlives start(), even
    // if the process dies mid-consultation. Keep that copy ahead of any await.
    if (req._snapshot) store.cleanupJobDir(groupId);

    // The members of a follow-up to a group can be at different rounds.
    const { round } = members[0];
    const sameRound = members.every((m) => m.round === round);
    const common = {
      group_id: groupId,
      ...(sameRound ? { round, rounds_remaining: POLICY.maxRounds - round } : {}),
      ...(fromGroup ? { followup_to_group: fromGroup.group.group_id, skipped: fromGroup.skipped } : {}),
      ...(parentEntries.length ? { exposed_from_parent: inheritedSummary(exposeManifest) } : {}),
      mode: req.mode,
      // Counted, not refused: a brief of facts alone is a legitimate
      // consultation, but one about code that hands over no file is one the
      // consultant answers without having seen the repository.
      files_exposed: exposeManifest?.totals.files ?? 0,
      ...(exposeManifest?.totals.files ? {} : {
        files_note: 'no file was handed over, so the consultant answers from the brief alone; if this is about code in a repository, consult_cancel and start again with context.expose_paths',
      }),
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
        cli: job.cli,
        model: job.model,
        poll_with: `consult_get({ job_id: "${job.job_id}" })`,
      };
    }
    return {
      ...common,
      question: group.question, // the redacted text every member was actually sent
      jobs: members.map((m) => ({
        job_id: m.job_id, chain_id: m.chain_id, target: m.target, cli: m.cli, model: m.model,
        ...(sameRound ? {} : { round: m.round, rounds_remaining: POLICY.maxRounds - m.round }),
      })),
      poll_with: `consult_get({ group_id: "${groupId}" })`,
      note: 'Every consultant got the identical brief. When they come back, compare the grounds behind the points that differ; matching summaries are not evidence of agreement.',
    };
  }

  // The rounds before a follow-up, from the history on disk and from memory
  // (memory wins: it can hold a verdict written since the round was saved).
  // Each point goes with the lead's verdict on it, so the consultant answers
  // knowing which of its points were checked and how they came out.
  #chainRounds(chainId) {
    const byRound = new Map(store.loadChain(chainId).map((j) => [j.round, j]));
    for (const j of this.jobs.values()) if (j.chain_id === chainId) byRound.set(j.round, j);
    return [...byRound.values()];
  }

  #chainHistory(chainId) {
    return this.#chainRounds(chainId)
      .filter((j) => j.status === 'completed' && j.result)
      .sort((a, b) => a.round - b.round)
      .map((j) => {
        const verdicts = new Map((j.record?.entries ?? []).map((e) => [e.id, e]));
        // The checked points first, then the unchecked ones, each with the
        // lead's verdict and effect when there is one.
        const ordered = (items, shape) => [
          ...items.filter((x) => verdicts.has(x.id)),
          ...items.filter((x) => !verdicts.has(x.id)),
        ].map((x) => ({ id: x.id, ...shape(x), verdict: verdicts.get(x.id)?.verdict ?? null, effect: verdicts.get(x.id)?.effect ?? null }));
        const checked = (x) => x.verdict !== null;
        const findings = ordered(j.result.findings, (f) => ({ point: f.point, grounds: f.grounds ?? null }));
        return {
          round: j.round,
          mode: j.mode,
          question: j.question,
          summary: j.result.summary,
          // Every checked finding; of the rest, the first five.
          findings: [...findings.filter(checked), ...findings.filter((f) => !checked(f)).slice(0, 5)],
          unknowns: ordered(j.result.unknowns, (u) => ({ point: u.item })).slice(0, 5),
          next_checks: ordered(j.result.next_checks, (c) => ({ point: c.check })).slice(0, 5),
        };
      });
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
    const consultant = consultantByName(job.target);
    const cli = consultant.cli;
    const adapter = ADAPTERS[cli];
    const workdir = store.makeWorkdir(job.job_id);
    // Each member gets its own copy of the group's one snapshot: members run
    // at the same time and their job directories are cleaned up
    // independently, so one shared tree would be removed underneath a
    // consultant still reading it.
    if (req._snapshot) {
      try {
        fs.cpSync(req._snapshot, path.join(workdir, 'workspace'), { recursive: true });
      } catch (err) {
        return this.#fail(job, 'spawn_error', `could not copy the exposed files: ${err.message}`);
      }
    }
    // start() renders the brief and hands it in: every member of a fan-out is
    // sent the same request in the same words, with only its own earlier rounds
    // added on a follow-up to the group.
    const text = brief ?? renderBrief(req, chain);
    const schemaPath = store.writeJobArtifact(job.job_id, 'response-schema.json', JSON.stringify(CONSULT_RESULT_SCHEMA, null, 2));
    const sandbox = adapter.prepareSandbox ? adapter.prepareSandbox({ workdir, network: req.network }) : null;

    try {
      const t = POLICY.clis[cli];
      const envProblem = operatorEnvProblem(cli, t.extraEnv, Object.keys(sandbox?.env ?? {}));
      if (envProblem) return this.#fail(job, 'spawn_error', `config clis.${cli}.env: ${envProblem}`);
      const env = childEnv(cli, sandbox?.env ?? {}, t.extraEnv);

      // A sandbox that found no credential to link would otherwise reach the
      // child, which reports whatever generic "not logged in" its vendor
      // emits -- with no hint that severally searched a specific HOME and
      // came back empty. That is exactly the case an operator who has moved
      // their credentials (or set SEVERALLY_AGY_CRED_HOME) needs named.
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
      // Scoped to antigravity on purpose: the message and the alternative
      // variables below are the Gemini ones. The opencode sandbox reports
      // `credentials: "missing"` the same way, but its only credential is
      // auth.json -- there is no env-var alternative to name -- so its
      // unauthenticated child is classified by classifyMessage like any other
      // auth failure the CLI reports.
      // Read from `env`, not process.env: what matters is what the child will
      // actually receive. No test can currently tell the two apart, because
      // childEnv keeps GEMINI_*/GOOGLE_* for the only target that has a
      // sandbox -- so do not "simplify" this to process.env.
      if (cli === 'antigravity' && sandbox && sandbox.credentials === 'missing' && !hasApiCredential(env)) {
        return this.#fail(
          job,
          'auth',
          `no ${t.label} credential to hand the consultant: nothing at `
          + `${sandbox.credentialsSource}, and none of ${ALL_API_CREDENTIAL_VARS.join(' / ')} names a `
          + 'usable credential. Log in with that CLI, point SEVERALLY_AGY_CRED_HOME at the home '
          + 'directory that holds the token, or set one of those variables to authenticate with an API key '
          + 'instead.',
        );
      }

      const budgetMs = timeoutMs(consultant);
      job.status = 'running';
      job.started_at = new Date().toISOString();
      this.#mark(job);
      const t0 = Date.now();

      // One-time per-process capability probe (e.g. the opencode adapter
      // discovering 2.x-only flags through `run --help`). Inside the clock:
      // its latency is part of this job's duration and budget, not free time
      // before the meter starts.
      if (adapter.prepare) await adapter.prepare();
      const invocation = adapter.buildInvocation({
        workdir,
        schemaPath,
        guardrails: renderGuardrails(Boolean(req._snapshot), req.network),
        sandbox,
        consultant,
        hasExposedPaths: Boolean(req._snapshot),
        network: req.network,
      });

      const argsProblem = extraArgsProblem(cli, invocation.args, t.extraArgs);
      if (argsProblem) return this.#fail(job, 'spawn_error', `config clis.${cli}.args: ${argsProblem}`);
      invocation.args = withExtraArgs(invocation.args, t.extraArgs);
      assertNoForbiddenFlags(cli, invocation.args);
      // What this consultant was actually launched with, read off the
      // invocation and the sandbox rather than restated from intent, so the
      // record says what held for this run.
      job.boundary = adapter.boundary?.({ args: invocation.args, sandbox, network: req.network,
        hasExposedPaths: Boolean(req._snapshot) }) ?? null;

      const attempt = (timeout) => {
        const { handle, done } = runChild({
          command: invocation.command,
          args: invocation.args,
          cwd: workdir,
          env,
          input: text,
          timeoutMs: timeout,
          onCancelSignal: (fn) => job._cancelFns.push(fn),
          compactLine: adapter.compactLine,
          settleAfter: adapter.settleAfter,
          stopSignal: adapter.stopSignal,
        });
        job._handle = handle;
        if (job.cancelRequested) handle.stop();
        return done;
      };

      // Two kinds of re-run, both inside the job's original wall-clock budget
      // and only while MIN_RETRY_MS of it remains: the one recovery an adapter
      // may offer (opencode 2.x ignores auth.json and reads credentials from
      // its session database, which the failed run has just created), and up
      // to POLICY.maxAutoRetries re-runs of a transient failure, after a wait.
      // Same consultant, same model, same brief: a re-run never picks another
      // mind. Every earlier failure is kept in job.retries.
      let run = await attempt(budgetMs);
      let interpreted;
      let authTried = false;
      let autoRetries = 0;
      for (;;) {
        // Read off the consultant's own event stream, last attempt only; null
        // where the CLI does not stream its tool calls (Claude Code).
        job.tool_calls = adapter.toolCalls?.(run) ?? null;
        job.duration_ms = Date.now() - t0;
        job.finished_at = new Date().toISOString();
        // The sandbox HOME holding the consultant's own log is removed below,
        // so what it left is copied into the history first.
        if ((run.stalled || run.timedOut || run.cancelled) && adapter.diagnostics && sandbox) {
          try {
            job.diagnostics = store.writeDiagnostics(job.chain_id, job.round, redact(adapter.diagnostics({ run, sandbox })));
          } catch { /* history is best effort */ }
        }
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
          // "this one just needs a longer budget". What it had written is kept
          // as material for the lead, never as an answer.
          const trail = adapter.progress?.(run) ?? null;
          job.partial_output = partialOutput(run);
          return this.#fail(
            job,
            'timeout',
            `consultant exceeded the ${budgetMs} ms budget and was stopped`,
            trail ? `no answer was produced; it was still working when the budget ran out: ${trail}` : null,
          );
        }
        const lastMessageText = invocation.lastMessagePath ? store.readIfExists(invocation.lastMessagePath) : '';
        interpreted = adapter.interpret({ ...run, lastMessageText });
        // An answer after an error the CLI reported is kept only if it parses;
        // otherwise it is that error, re-run like any other.
        const { recoveredError } = interpreted;
        if (interpreted.ok && recoveredError && !parses(interpreted.text)) {
          interpreted = { ok: false, ...recoveredError, usageRaw: interpreted.usageRaw };
        }
        if (interpreted.ok) break;
        // No envelope at all: what stderr holds is the dump from stopping it,
        // not a message to classify. Not re-run, as it may have spent its quota.
        if (run.stalled && !interpreted.usageRaw) {
          return this.#fail(job, 'cli_error',
            `${invocation.command} wrote its finish step but neither returned a result nor exited, and was stopped`,
            adapter.progress?.(run) ?? null);
        }

        const remaining = budgetMs - (Date.now() - t0);
        if (!authTried && adapter.recoverAuthFailure && sandbox) {
          authTried = true;
          const seeded = adapter.recoverAuthFailure({ interpreted, sandbox, model: job.model });
          if (seeded && remaining >= MIN_RETRY_MS) {
            job.retries.push({ failure_kind: interpreted.failureKind, reason: 'credentials re-seeded', at: new Date().toISOString(), usage: adapter.usageRecord(interpreted.usageRaw) });
            run = await attempt(remaining);
            continue;
          }
        }
        const wait = POLICY.retryBackoffMs * 3 ** autoRetries;
        if (AUTO_RETRY_KINDS.includes(interpreted.failureKind) && autoRetries < POLICY.maxAutoRetries
          && remaining - wait >= MIN_RETRY_MS) {
          autoRetries += 1;
          job.retries.push({ failure_kind: interpreted.failureKind, reason: `transient; re-run after ${wait} ms`, at: new Date().toISOString(), usage: adapter.usageRecord(interpreted.usageRaw) });
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, wait);
            job._cancelFns.push(() => { clearTimeout(timer); resolve(); });
          });
          if (job.cancelRequested) return this.#fail(job, 'cancelled', 'consultation cancelled by the lead');
          run = await attempt(budgetMs - (Date.now() - t0));
          continue;
        }
        break;
      }

      // Without an answer, a process left holding the pipes is the failure to report.
      const leftover = run.pipesForced
        && `${invocation.command} exited, but a process it started kept its output open and was stopped`;
      if (!interpreted.ok) {
        job.usage = adapter.usageRecord(interpreted.usageRaw);
        if (leftover) return this.#fail(job, 'cli_error', leftover, interpreted.message);
        return this.#fail(job, interpreted.failureKind, interpreted.message);
      }

      let normalized;
      try {
        normalized = normalizeResult(interpreted.text);
      } catch (err) {
        if (err instanceof OutputError) {
          // The last text part carried no contract JSON -- but an opencode
          // answer can be split across completed parts (a contract followed
          // by a prose epilogue wins as "last", yet holds no JSON). Walk the
          // earlier parts newest-first before giving up.
          const fallbacks = (interpreted.earlierTextParts ?? []).slice().reverse();
          for (const candidate of fallbacks) {
            try {
              normalized = normalizeResult(candidate);
              break;
            } catch (retryErr) {
              if (!(retryErr instanceof OutputError)) throw retryErr;
            }
          }
          if (!normalized) {
            job.usage = adapter.usageRecord(interpreted.usageRaw);
            if (leftover) return this.#fail(job, 'cli_error', leftover, err.message);
            return this.#fail(job, 'invalid_output', err.message, redact(String(err.detail ?? '')).slice(0, 1200));
          }
        } else {
          throw err;
        }
      }

      job.result = normalized.result;
      const notes = [
        adviceCaveat(normalized),
        sameVendorCaveat(job.caller, job.caller_model, consultant),
        interpreted.recoveredError && `the consultant's CLI reported an error mid-run and then finished its answer: ${redact(interpreted.recoveredError.message).slice(0, 300)}`,
        leftover && 'the answer parsed, but a process the consultant started kept its output open after it exited and was stopped (one that left its process group may still be running)',
      ].filter(Boolean);
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

  // The in-progress marker other processes read (see store.writeRunning).
  #mark(job) {
    try { store.writeRunning({ ...this.#record(job), owner: job._owner }); } catch { /* history is best effort */ }
  }

  #finish(job) {
    try { store.persistRound(this.#record(job)); } catch { /* history is best effort */ }
    store.removeRunning(job.job_id);
    store.releaseSeat(job.job_id);
    LIVE_HERE.delete(job.job_id);
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
    if (input.records !== undefined) return this.#recordMany(input);
    const allowed = ['job_id', 'entries', 'reflection'];
    const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
    if (unknown.length) {
      throw new RequestError(
        `${unknown.map((k) => `"${k}"`).join(', ')} cannot be written here; this call takes ${allowed.join(', ')}, or records`
        + (unknown.includes('prediction')
          ? '. A prediction is written when the consultation starts (consult_start\'s `prediction`) and cannot be added or changed afterwards -- that is what makes it a prediction'
          : ''),
        'unknown_field',
      );
    }
    const change = this.#checkRecord(input);
    const saved = this.#saveRecord(change);
    if (saved.error) throw new RequestError(saved.message, saved.error);
    return saved;
  }

  // Several consultations at once -- one fan-out's answers, typically. Every
  // record is checked before anything is written, so a bad id leaves the
  // history as it was; then each job is written on its own, and a write that
  // fails is named in the answer rather than reported as saved.
  #recordMany(input) {
    const extra = Object.keys(input).filter((k) => k !== 'records');
    if (extra.length) {
      throw new RequestError(`records cannot be combined with ${extra.map((k) => `"${k}"`).join(', ')}; put each job's verdicts inside records`, 'unknown_field');
    }
    const { records } = input;
    if (!Array.isArray(records) || records.length === 0) {
      throw new RequestError('records must be a non-empty array of { job_id, entries?, reflection? }', 'records_required');
    }
    const problems = [];
    const changes = [];
    const seen = new Set();
    records.forEach((r, i) => {
      try {
        if (seen.has(r?.job_id)) throw new RequestError(`job "${r.job_id}" appears twice; give each job one record`, 'duplicate_job');
        seen.add(r?.job_id);
        const unknown = Object.keys(r ?? {}).filter((k) => !['job_id', 'entries', 'reflection'].includes(k));
        if (unknown.length) throw new RequestError(`${unknown.map((k) => `"${k}"`).join(', ')} cannot be written here`, 'unknown_field');
        changes.push(this.#checkRecord(r ?? {}));
      } catch (err) {
        if (!(err instanceof RequestError)) throw err;
        problems.push({ index: i, job_id: r?.job_id ?? null, error: err.code, message: err.message });
      }
    });
    if (problems.length) {
      throw new RequestError(
        `nothing was recorded: ${problems.map((p) => `records[${p.index}] (${p.job_id}): ${p.message}`).join('; ')}`,
        'invalid_records',
        problems,
      );
    }
    const results = changes.map((c) => this.#saveRecord(c));
    const notSaved = results.filter((r) => r.error);
    return { saved: results.length - notSaved.length, not_saved: notSaved.length, results };
  }

  // Everything that can be wrong with a record, found before anything is
  // written: what the job's record and reflection become, or a RequestError.
  #checkRecord({ job_id: jobId, entries, reflection }) {
    if (entries === undefined && reflection === undefined) {
      throw new RequestError('pass entries (verdicts on specific points), reflection (what the answer added), or both', 'nothing_to_record');
    }
    // A job this process ran is in memory; one from an earlier session is read
    // back from its round file, so a verdict can still be written once the
    // checking -- which may take days -- is actually done.
    const live = this.jobs.get(jobId);
    const job = live ?? store.loadRound(jobId);
    if (!job) {
      throw new RequestError(
        `no consultation with job_id "${jobId}" in this session or in ~/.severally/history`,
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
    let newReflection;
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
      newReflection = { delta, related_item_ids: related, recorded_at: now };
    }

    const newRecord = entries === undefined
      ? undefined
      : { updated_at: now, entries: ids.filter((id) => merged.has(id)).map((id) => merged.get(id)) };
    return { job, live, record: newRecord, reflection: newReflection };
  }

  #saveRecord({ job, live, record, reflection }) {
    const was = { record: job.record, reflection: job.reflection };
    if (reflection !== undefined) job.reflection = reflection;
    if (record !== undefined) job.record = record;
    // An update to a round that already happened, so the index line stays as it
    // was: the history has one line per consultation, not one per edit.
    // Unlike the round itself, a verdict exists nowhere else once this server
    // exits, so a failed write is the lead's to know about, not best effort.
    try {
      store.persistRound(live ? this.#record(job) : job, { appendIndex: false });
    } catch (e) {
      // Not saved, so not shown as recorded either.
      Object.assign(job, was);
      return {
        job_id: job.job_id,
        error: 'record_not_saved',
        message: `the verdict for "${job.job_id}" could not be written to the history (${e.message}); record it again`,
      };
    }
    // Counts only: the entries are what the lead just wrote, and
    // consult_get({ job_id, ids }) reads any of them back with its verdict.
    const summary = job.record && recordSummary(job);
    return {
      job_id: job.job_id,
      chain_id: job.chain_id,
      round: job.round,
      record: summary ? { updated_at: summary.updated_at, verdicts: summary.verdicts, coverage: summary.coverage } : null,
      reflection_saved: job.reflection != null,
    };
  }

  async wait(jobId, waitMs, opts, signal) {
    const job = this.jobs.get(jobId);
    if (!job) return this.#waitOnDisk(() => this.view(jobId, opts), waitMs, signal);
    const budget = Math.min(Math.max(0, waitMs ?? 0), POLICY.maxWaitMs);
    if (budget === 0 || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return this.view(jobId, opts);
    }
    await settled(job.promise, budget, signal);
    return this.view(jobId, opts);
  }

  // A consultation another process runs has no promise here, so its history
  // is re-read once a second until it is no longer running or the wait is up.
  async #waitOnDisk(read, waitMs, signal) {
    const until = Date.now() + Math.min(Math.max(0, waitMs ?? 0), POLICY.maxWaitMs);
    let view = read();
    while (view && ['running', 'queued'].includes(view.status) && Date.now() < until && !signal?.aborted) {
      await settled(null, Math.min(1000, until - Date.now()), signal);
      view = read();
    }
    return view;
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      const view = this.view(jobId);
      if (!view) return null;
      return {
        ...view,
        cancel_effect: view.status === 'running' || view.status === 'queued'
          ? 'nothing signalled: this consultation runs in another severally process, and only that process can cancel it'
          : `job was already ${view.status}`,
      };
    }
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
  #shapeGroup(group, members, { detail } = {}) {
    const full = detail === 'full';
    const cancelling = members.some((m) => m.status === 'cancelling');
    const live = cancelling || members.some((m) => m.status === 'running' || m.status === 'queued');
    const missing = group.job_ids.length - members.length;
    // "Nothing live" is not the same as "there is something to compare": a
    // group whose every member failed or was cancelled lands here too, and
    // telling the lead to compare divergences between zero answers invites
    // exactly the "the consultants had no concerns" summary that a failure
    // must never be turned into.
    const anyResult = members.some((m) => m.result);
    // Every member of a fan-out was sent the byte-identical brief -- that is
    // the whole point of a fan-out -- so printing it once per member says the
    // same thing three times. Hoist one copy to the group and strip it from
    // the members, which keeps the payload readable without losing anything.
    const firstBrief = members.find((m) => m.brief)?.brief ?? null;
    const groupBrief = firstBrief && !full
      ? { ...firstBrief, full_with: `consult_get({ group_id: "${group.group_id}", detail: "full" }) or consult_export` }
      : firstBrief;
    // The limits are the server's, not a member's: one copy, on the group.
    // By default a member is only its state: what there is to compare is in
    // `comparison`, once, and the full answer is one consult_get({ job_id }) away.
    const trimmed = members.map(({ brief, limits, ...rest }) => {
      if (full) return rest;
      const message = rest.failure && cut(rest.failure.message, FAILURE_MESSAGE_CHARS);
      const progress = cut(rest.progress, FAILURE_MESSAGE_CHARS);
      const cutShort = progress !== rest.progress || Boolean(rest.failure && (message !== rest.failure.message || rest.failure.detail));
      return {
        job_id: rest.job_id,
        target: rest.target,
        status: rest.status,
        duration_ms: rest.duration_ms,
        progress,
        cancel_effect: rest.cancel_effect,
        failure: rest.failure && { kind: rest.failure.kind, retriable: rest.failure.retriable, message },
        // The failure's detail, and a message or progress past its length, are in the member's own view.
        ...(cutShort ? { truncated: true, full_with: `consult_get({ job_id: "${rest.job_id}" })` } : {}),
      };
    });
    const question = full ? group.question : cut(group.question, QUESTION_CHARS);
    const view = {
      group_id: group.group_id,
      status: cancelling ? 'cancelling' : (live ? 'running' : 'done'),
      mode: group.mode,
      question,
      ...(question !== group.question ? { question_full_with: `consult_get({ group_id: "${group.group_id}", detail: "full" })` } : {}),
      brief: groupBrief,
      members_expected: group.job_ids.length,
      members_available: members.length,
      // History is capped, so an older member can already be gone. Say so:
      // a fan-out that quietly reports fewer answers than it asked for is
      // worse than one that admits the comparison is partial.
      incomplete_note: missing > 0
        ? `${missing} of ${group.job_ids.length} member consultation(s) have aged out of this session's history; the comparison below is partial`
        : null,
      members: trimmed,
      comparison: null,
      cancellable: live,
      next_step: cancelling
        ? 'poll consult_get with this group_id until every member reads cancelled'
        : live
          ? 'poll consult_get again with this group_id, or consult_cancel it'
          : anyResult
            ? 'list the points where the consultants diverge, check the grounds behind each one (consult_get({ job_id, ids: ["f2", ...] }) on a member returns those points whole, with their grounds: fetch every point you mean to adopt, that decides your call, that rests on thin grounds, or that every consultant assumes; unknowns u1... and next_checks c1... are fetched the same way; consult_get({ job_id }) returns the whole answer, for its alternatives\' tradeoffs and references), then spend a follow-up (followup_to on that member job) only on a divergence that would change your decision. Write what checking showed for every member in one call: consult_record({ records: [{ job_id, entries: [{ id, verdict, effect }] }, ...] })'
            : 'no advice was obtained: no member of this fan-out produced a result (see each member\'s failure.kind). Say so plainly -- this is not "the consultants had no concerns" -- and proceed on your own judgement',
      // The limits went out with consult_start, and consult_list has them;
      // by default they are not repeated here, where their size grows with
      // the number of consultants configured rather than asked.
      limits: live || !full ? null : limitsSummary(),
    };
    // The side-by-side gets what the rest of the response leaves of GROUP_CHARS.
    // While no one has finished there is nothing to set side by side, and an
    // empty column per consultant is only context spent on every poll.
    const anyFinished = members.some((m) => ['completed', 'failed', 'cancelled'].includes(m.status));
    if (anyFinished) view.comparison = comparison(members, full ? Infinity : GROUP_CHARS - printed(view));
    return view;
  }

  groupView(groupId, opts) {
    const group = this.groups.get(groupId) ?? store.loadGroup(groupId);
    if (!group) return null;
    return this.#shapeGroup(group, group.job_ids.map((jid) => this.view(jid, opts)).filter(Boolean), opts);
  }

  async waitGroup(groupId, waitMs, opts, signal) {
    const group = this.groups.get(groupId);
    // A fan-out from another process or an earlier session: nothing here to
    // wait on, so report what the history holds.
    if (!group) return this.#waitOnDisk(() => this.groupView(groupId, opts), waitMs, signal);
    const budget = Math.min(Math.max(0, waitMs ?? 0), POLICY.maxWaitMs);
    if (budget > 0) {
      const promises = group.job_ids.map((jid) => this.jobs.get(jid)?.promise).filter(Boolean);
      await settled(Promise.all(promises), budget, signal);
    }
    return this.groupView(groupId, opts);
  }

  cancelGroup(groupId) {
    const group = this.groups.get(groupId);
    if (!group) {
      const view = this.groupView(groupId);
      if (!view) return null;
      return { ...view, cancel_effect: 'nothing signalled: this fan-out was started by another severally process or before a restart, and only a live process can cancel its own consultants' };
    }
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

  /**
   * Stop every consultation this process runs: SIGTERM, up to killGraceMs for
   * them to exit (each is then recorded as cancelled), then SIGKILL whatever
   * is left of their process groups. Queued jobs are cancelled before they
   * can launch a CLI.
   */
  async shutdown(graceMs = POLICY.killGraceMs) {
    const live = [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued');
    const handles = [];
    for (const job of live) {
      job.cancelRequested = true;
      for (const fn of job._cancelFns) fn();
      if (job._handle) { handles.push(job._handle); job._handle.stop(); }
    }
    const settled = Promise.all(live.map((j) => j.promise).filter(Boolean));
    await Promise.race([settled, new Promise((r) => setTimeout(r, graceMs).unref?.())]);
    // A queued job may have launched its CLI meanwhile (it stops it at once),
    // so whatever still holds a handle now is killed too.
    for (const job of live) if (job._handle) handles.push(job._handle);
    for (const h of new Set(handles)) h.forceKill();
    // A killed child closes at once; give that a moment so the job is written
    // to history as cancelled, rather than left for the next start to call
    // interrupted.
    await Promise.race([settled, new Promise((r) => setTimeout(r, 1000).unref?.())]);
  }

  /** The synchronous last resort for process exit: no waiting is possible there. */
  killNow() {
    for (const job of this.running) {
      if (!job._handle) continue;
      job._handle.stop();
      job._handle.forceKill();
    }
  }
}

// Each entry of a follow-up's copy that the parent round also exposed is
// marked with whether its bytes changed since then (per entry: the record
// keeps one sha256 per entry, not per file). Its diff and the re-copied
// files of that diff are the same entry for this purpose.
// ponytail: a diff recorded before 1.11 hashed its files in git's order, not
// path order, so its re-copy can read as changed when it is not.
function markSinceParent(manifest, parentEntries) {
  const key = (source, kind) => `${kind === 'change_files' ? 'diff' : kind}\0${source}`;
  const before = new Map(parentEntries.map((e) => [key(e.source, e.kind), e.sha256]));
  for (const e of manifest.entries) {
    const k = key(e.source, e.kind);
    if (before.has(k)) e.changed = before.get(k) !== e.sha256;
  }
}

// What consult_start says a follow-up copied again: the entries it shares
// with the parent round, the ones left out and why, and how many files that
// added to this round.
function inheritedSummary(manifest) {
  const carried = manifest.entries.filter((e) => e.inherited);
  return {
    entries: carried.map((e) => ({ exposed_as: e.exposedAs, kind: e.kind, files: e.files, changed: e.changed ?? null })),
    // Only what an earlier round showed carries the name it had there.
    left_out: manifest.skipped.filter((x) => x.exposed_as)
      .map((x) => ({ exposed_as: x.exposed_as, reason: x.reason })),
    files: carried.reduce((n, e) => n + e.files, 0),
  };
}

// The points a verdict can name, in the order they appear in the answer.
// The tail of what a timed-out consultant had written, credential-masked. It
// is the raw output stream, unparsed: material the lead may read, never an
// answer, which is why it sits beside the failure and not in `result`.
const PARTIAL_TAIL_CHARS = 8_000;
function partialOutput(run) {
  const out = String(run.stdout ?? '');
  if (!out.trim()) return null;
  return {
    partial: true,
    chars_total: out.length,
    // The capture keeps the head of a very long stream, so the tail can stop short of the end.
    capture_truncated: Boolean(run.truncated),
    tail: redact(out.slice(-PARTIAL_TAIL_CHARS)),
    stopped_at: new Date().toISOString(),
    note: 'raw output stream of a consultant that was stopped at its time budget; unparsed and unverified, not an answer',
  };
}

// Waits for `promise` (null: for nothing), at most `ms`, and no longer than
// `signal` stays unaborted. The timer goes with the wait: a ten-minute wait
// cut short leaves nothing behind.
async function settled(promise, ms, signal) {
  let timer;
  let stop;
  const until = new Promise((resolve) => {
    stop = resolve;
    timer = setTimeout(resolve, ms);
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', resolve, { once: true });
  });
  try {
    await (promise ? Promise.race([promise, until]) : until);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

function parses(text) {
  try {
    normalizeResult(text);
    return true;
  } catch (err) {
    if (err instanceof OutputError) return false;
    throw err;
  }
}

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
  return t.length > POLICY.output.itemTextMax ? `${t.slice(0, POLICY.output.itemTextMax)}\n…[truncated by severally]` : t;
}

// A follow-up restates what the round before was given unless it says
// otherwise: the lead sends the new question, not the whole brief again. Only
// a key left out is inherited -- one passed, even as an empty list, replaces
// it -- and the validation that follows sees the result. Files are not:
// copying them again stays expose_from_parent, named in the call (schema.mjs).
function inherit(raw, round) {
  const { brief } = round;
  // A round kept off the web stays off: the material it carries over is the same.
  const out = raw.network === undefined && round.network ? { ...raw, network: round.network } : { ...raw };
  if (!brief) return out;
  for (const k of ['objective', 'success_criteria', 'constraints']) {
    if (out[k] === undefined && brief[k] != null && !(Array.isArray(brief[k]) && !brief[k].length)) out[k] = brief[k];
  }
  const ctx = { ...(raw.context ?? {}) };
  for (const k of ['facts', 'proposal', 'counterpoints']) {
    if (ctx[k] === undefined && brief[k] != null && !(Array.isArray(brief[k]) && !brief[k].length)) ctx[k] = brief[k];
  }
  // The diff expose_diff added is not the lead's material: it is taken again
  // (or replaced) through expose_from_parent, against the files as they are now.
  // It is the last artifact (appended after the lead's own), so only that one is dropped.
  const artifacts = [...(brief.artifacts ?? [])];
  const last = artifacts.at(-1);
  if (brief.expose_paths?.entries?.some((e) => e.kind === 'diff') && last?.kind === 'diff' && last.name.startsWith('git diff ')) artifacts.pop();
  if (ctx.artifacts === undefined && artifacts.length) {
    // Stored with null for an absent language or source; the request schema takes them as optional strings.
    ctx.artifacts = artifacts.map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v != null)));
  }
  out.context = ctx;
  return out;
}

function adviceCaveat(normalized) {
  const { result, quality } = normalized;
  const notes = [];
  if (result.evidence_basis === 'insufficient') {
    notes.push('the consultant reported its evidence as insufficient: treat this as a request for more material, not as advice');
  } else if (result.evidence_basis === 'thin') {
    notes.push('the consultant reported thin evidence: weigh the findings accordingly');
  } else if (!result.evidence_basis) {
    notes.push('the consultant did not say how well its evidence supports the answer (evidence_basis)');
  }
  // Read first in a comparison; a missing one is shown as null there, and named here.
  if (!result.stance) notes.push('the answer gives no bottom line (stance): read the summary and findings for one before relying on it');
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
// vendor's model family -- so flag it rather than let it pass as one. The
// lineage is the consultant's model's, not its CLI's: OpenCode can run GLM
// for a GLM lead and DeepSeek for anyone.

function sameVendorCaveat(caller, callerModel, consultant) {
  // The lead's lineage: its declared model if that names one, else its CLI's
  // own. An unknown lineage on either side is no caveat -- not a guess.
  const callerVendor = (callerModel ? vendorOf(callerModel) : null) ?? (caller ? CLI_VENDORS[caller] ?? null : null);
  const vendor = consultant.vendor;
  if (!callerVendor || !vendor || callerVendor !== vendor) return null;
  // Say what a fresh session of the same lineage removes and what it keeps.
  // The earlier wording ("prefer the other two") was read, in live runs, as a
  // verdict on the answer: leads filed this consultant's findings under
  // Rejected without checking their grounds.
  // When the lead declared its model, say whether this is the same head or a
  // different model of the same lineage -- a Fable lead asking Opus gets
  // capability it does not have, but not a different training lineage. The
  // lead's model is its own declaration; the consultant's is what was launched.
  // When the two names neither agree word for word nor differ outright
  // ("claude-opus-5" and "claude-opus-5-5"), both are relayed with no
  // same/different verdict: a false "different" reads as more independence
  // than there is.
  const consultantModel = consultant.model;
  const match = callerModel ? sameModel(callerModel, consultantModel) : null;
  const models = !callerModel
    ? `the consultant runs the same vendor's model family as you (${vendor}).`
    : match === 'unknown'
      ? `the consultant runs the same vendor's model family as you (${vendor}). You declared ${callerModel}; it ran ${consultantModel}. This server cannot tell whether those are one model, so it relays both without saying.`
      : match === 'same'
        ? `the consultant runs the same vendor's model family as you (${vendor}), and the same model (${consultantModel}, as you declared).`
        : `the consultant runs the same vendor's model family as you (${vendor}), on a different model: you declared ${callerModel}, it ran ${consultantModel}. A different model of the same lineage is a different model, not a second lineage.`;
  return `${models} A fresh session removes what your own session accumulated — history, sunk cost, drift toward your framing — but not what the lineage shares: training-data blind spots and the same reflexes toward this brief's wording. Weigh it as a fresh-context re-read rather than an independent opinion; that is not a reason to skip checking its grounds like any other answer`;
}

// A mechanical side-by-side. The server deliberately does not decide whether
// the consultants agree: inventing agreement that is not there is exactly the
// failure a second opinion is supposed to prevent.
function comparison(members, budget) {
  // Each column first pays for its fixed fields; the rest is its budget.
  const each = (budget - COMPARISON_NOTE_CHARS) / Math.max(1, members.length) - COLUMN_FIXED_CHARS;
  let columns = members.map((m) => byTarget(m, each));
  // What the short answers did not spend goes to the ones that were cut.
  const cutShort = columns.filter((c) => c.truncated).length;
  if (each !== Infinity && cutShort) {
    const spare = columns.reduce((n, c) => n + (c.truncated ? 0 : Math.max(0, each + COLUMN_FIXED_CHARS - printed(c))), 0);
    columns = members.map((m, i) => (columns[i].truncated ? byTarget(m, each + spare / cutShort) : columns[i]));
  }
  return {
    by_target: columns,
    note:
      'This server does not judge whether the consultants agree: similar summaries are not evidence of agreement. ' +
      'Each stance is the consultant\'s own declaration, relayed as given -- consultants that share a finding can still ' +
      'declare opposite stances, and that is a divergence. Compare the grounds behind each point yourself, and spend a ' +
      'follow-up only where a divergence would change your decision.',
  };
}

// One consultant's column. Unless `budget` is Infinity, its texts are cut so
// that the column takes at most `budget` characters as printed, however many
// consultants answered at whatever length. Each list gets an even share of
// what is left (what one list does not spend goes to the next), its items are
// shortened to fit the share before any is left out. A cut is flagged, never hidden: `truncated` says so,
// `omitted` counts the items a list could not hold, and `full_with` names the
// call that has everything.
function byTarget(m, budget) {
  const full = budget === Infinity;
  let left = budget;
  let truncated = false;
  const omitted = {};
  const clip = (s, max) => {
    const out = full ? s : cut(s, max);
    if (out !== s) truncated = true;
    return out;
  };
  const item = Math.min(ITEM_CHARS, budget / 10);
  const list = (name, items = [], fields, build, part, floor = MIN_TEXT_CHARS) => {
    if (full) return items.map((x) => build(x, Infinity));
    let share = left * part;
    // What one item takes with every text cut to nothing, so the rest of the
    // share can be split among the texts.
    // A probe, not a cut: it must not mark the column truncated.
    const flagged = truncated;
    const bare = items.reduce((n, x) => Math.max(n, printed(build(x, 0))), 0);
    truncated = flagged;
    const cap = Math.max(floor, Math.min(item, (share / Math.max(1, items.length) - bare) / fields));
    const out = [];
    for (const x of items) {
      const v = build(x, cap);
      const n = printed(v);
      if (n > share) break;
      share -= n;
      left -= n;
      out.push(v);
    }
    if (out.length < items.length) { omitted[name] = items.length - out.length; truncated = true; }
    return out;
  };
  const summary = clip(m.result?.summary ?? null, Math.min(SUMMARY_CHARS, budget / 3));
  const caveat = clip(m.quality?.caveat ?? null, Math.min(CAVEAT_CHARS, budget / 3));
  if (!full) left -= printed(summary) + printed(caveat);
  const r = m.result ?? {};
  // The findings first, with up to 60% of what is left and their points cut
  // as short as it takes: they are what gets recorded against, so their ids
  // matter most. The other lists then share the rest evenly.
  const findingPoints = list('finding_points', r.findings, 1,
    (f, n) => ({ id: f.id, severity: f.severity ?? null, point: clip(f.point, n) }), 0.6, 20);
  const decisionChangers = list('decision_changers', r.decision_changers, 2,
    (d, n) => ({ condition: clip(d.condition, n), changes_to: clip(d.changes_to, n) }), 1 / 4);
  const alternatives = list('alternative_options', r.alternatives, 1, (a, n) => clip(a.option, n), 1 / 3);
  const unknowns = list('unknowns', r.unknowns, 1, (u, n) => ({ id: u.id, item: clip(u.item, n) }), 1 / 2);
  const nextChecks = list('next_checks', r.next_checks, 1, (c, n) => ({ id: c.id, check: clip(c.check, n) }), 1 / 2);
  const disagreements = list('remaining_disagreements', r.remaining_disagreements, 3,
    (d, n) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, clip(v, n)])), 1);
  const entry = {
    job_id: m.job_id,
    target: m.target,
    cli: m.cli,
    status: m.status,
    failure_kind: m.failure?.kind ?? null,
    // Declared by the consultant, relayed unjudged. In live runs, leads that
    // saw two consultants share a finding read them as agreeing, when their
    // bottom lines were opposite; one word per consultant makes that
    // visible without the server interpreting anyone's summary.
    stance: m.result?.stance ?? null,
    confidence: m.result?.confidence ?? null,
    evidence_basis: m.result?.evidence_basis ?? null,
    summary,
    // Each with its id, so a point read here can be recorded against
    // (consult_record) or looked up in the member's full answer.
    finding_points: findingPoints,
    // How heavy this consultant said its own findings were, and what it said
    // would change its mind. Both were already in the per-member result and
    // both were being lost in the one view built for reading two answers
    // against each other -- the place where "they broadly agree" gets written.
    // Counted and relayed, never compared: two consultants naming the same
    // condition is for the lead to notice, not for the server to assert.
    severity_counts: tally((m.result?.findings ?? []).map((f) => f.severity ?? 'unrated')),
    decision_changers: decisionChangers,
    alternative_options: alternatives,
    unknowns,
    next_checks: nextChecks,
    remaining_disagreements: disagreements,
    caveat,
    // Counted, not judged: how many of this answer's points carry no verdict yet.
    points_without_verdict: m.result ? (m.record?.unrecorded ?? recordableIds(m.result)).length : null,
  };
  // A member's status and failure are in `members`; say them once.
  if (!full) { delete entry.cli; delete entry.status; delete entry.failure_kind; }
  if (Object.keys(omitted).length) entry.omitted = omitted;
  if (truncated) {
    entry.truncated = true;
    entry.full_with = `consult_get({ job_id: "${m.job_id}" })`;
  }
  return entry;
}

// The most a default group view takes as printed, and the most its question,
// a member's failure message, a summary, a caveat and one item of a list may
// take in it.
// COLUMN_FIXED_CHARS is what one column's fixed fields take, the note's the
// comparison note's.
const GROUP_CHARS = 19_500;
const COLUMN_FIXED_CHARS = 700;
const COMPARISON_NOTE_CHARS = 500;
const QUESTION_CHARS = 1_000;
const FAILURE_MESSAGE_CHARS = 300;
const SUMMARY_CHARS = 1_200;
const CAVEAT_CHARS = 1_500;
const ITEM_CHARS = 300;
const MIN_TEXT_CHARS = 40;

/**
 * The points of a finished answer the lead named (findings, unknowns,
 * next_checks by id), each whole and with the verdict recorded against it,
 * and how many of everything else there is: the grounds for exactly the
 * points being checked, without the rest of the answer. A projection, not a
 * summary. An id the answer does not have is refused with the ones it has.
 */
export function pointsOf(view, ids) {
  if (!view.result) {
    throw new RequestError(`consultation "${view.job_id}" is ${view.status} and has no answer to take points from`, 'no_result');
  }
  const r = view.result;
  const known = recordableIds(r);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length) {
    throw new RequestError(`${unknown.map((id) => `"${id}"`).join(', ')} not in this answer; it has: ${known.join(', ')}`, 'unknown_entry_id');
  }
  const verdicts = new Map((view.record?.entries ?? []).map((e) => [e.id, e]));
  const lists = { finding: r.findings, unknown: r.unknowns, next_check: r.next_checks };
  const points = [...new Set(ids)].map((id) => {
    const [kind, item] = Object.entries(lists).map(([k, l]) => [k, l.find((x) => x.id === id)]).find(([, x]) => x);
    return { kind, ...item, recorded: verdicts.get(id) ?? null };
  });
  return {
    job_id: view.job_id,
    chain_id: view.chain_id,
    round: view.round,
    target: view.target,
    status: view.status,
    stance: r.stance,
    evidence_basis: r.evidence_basis,
    caveat: view.quality?.caveat ?? null,
    points,
    // What this projection leaves out, counted; the whole answer is one call away.
    not_shown: {
      findings: r.findings.length - points.filter((p) => p.kind === 'finding').length,
      unknowns: r.unknowns.length - points.filter((p) => p.kind === 'unknown').length,
      next_checks: r.next_checks.length - points.filter((p) => p.kind === 'next_check').length,
      alternatives: r.alternatives.length,
      decision_changers: r.decision_changers.length,
      remaining_disagreements: r.remaining_disagreements.length,
      references: r.references.length,
    },
    full_with: `consult_get({ job_id: "${view.job_id}" })`,
    next_step: view.next_step,
  };
}

// What a value takes as the server prints it, nested four levels into the
// response: two-space JSON, every line indented eight more.
function printed(v) {
  const j = JSON.stringify(v, null, 2) ?? '';
  return j.length + 8 * j.split('\n').length;
}

// A text cut to `max` characters as printed in JSON, so a run of characters
// that JSON escapes (a control character takes six) cannot outgrow the cut.
function cut(s, max) {
  if (typeof s !== 'string') return s;
  const room = Math.max(0, Math.floor(max));
  const width = (t) => JSON.stringify(t).length - 2;
  if (width(s) <= room) return s;
  // One character of the room goes to the ellipsis, and a surrogate pair is
  // never split.
  let out = s.slice(0, Math.max(0, room - 1));
  while (out && width(out) > room - 1) out = out.slice(0, Math.floor(out.length * 0.8));
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return `${out}…`;
}

// A finished consultation's brief is what the lead wrote itself; by default it
// is named rather than repeated: its size and sha256 (of the JSON stored in
// the round file, so both can be checked against it), where it is kept, and
// what was copied -- skipped files counted by reason, not listed.
function compactBrief(view, detail) {
  if (detail === 'full' || !view.brief) return view;
  const json = JSON.stringify(view.brief);
  const ex = view.brief.expose_paths;
  return {
    ...view,
    brief: {
      chars: json.length,
      sha256: crypto.createHash('sha256').update(json).digest('hex'),
      // Under the severally home (~/.severally unless the operator moved it).
      history_file: path.relative(POLICY.home, store.roundPath(view.chain_id, view.round)),
      exposed: ex ? { ...ex.totals, skipped: tally((ex.skipped ?? []).map((x) => x.reason)) } : null,
      full_with: `consult_get({ job_id: "${view.job_id}", detail: "full" }) or consult_export`,
    },
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
      ? `check the grounds behind the points that matter, run the one check that would change the decision, then either decide, or spend one of your ${left} remaining round(s) on the specific divergences (followup_to: "${job.job_id}").`
      : 'rounds exhausted: decide with what you have.') + close;
  }
  if (job.failure?.kind === 'timeout' || job.failure?.kind === 'cli_error') return 'retriable: narrow the brief and start a new consultation';
  if (job.failure?.kind === 'interrupted') return 'the severally process running it exited before the consultant answered; start the consultation again if you still need it';
  if (job.failure?.kind === 'rate_limited') return 'the consultant was rate-limited and the server already re-ran it (see retries); try again in a few minutes, or proceed on your own judgement';
  if (job.failure?.kind === 'usage_limit' || job.failure?.kind === 'auth') return 'not a consultation outcome: the consultant never answered. Proceed on your own judgement, or fix the credentials/quota first';
  if (job.failure?.kind === 'invalid_output') return 'the consultant answered but not in the required shape; retry once with a shorter brief before giving up';
  return 'proceed on your own judgement and note that no peer input was obtained';
}

// Every spelling a token could name a flag by: `--name[=v]` as written, and for
// a single dash both a short flag with its value attached (`-sdanger-full-access`
// in clap) and a Go-style long flag (`-dangerously-skip-permissions`).
const flagNames = (a) => {
  if (!a.startsWith('-') || a === '-') return [];
  const name = a.split('=')[0];
  return a.startsWith('--') ? [name] : [name, a.slice(0, 2), `-${name}`];
};

/**
 * Why the operator's per-target `args` (config.json) cannot be added to this
 * invocation, or null. Any flag the adapter already sets is refused -- a
 * repeat would override it, and those flags are the isolation -- as are the
 * adapter's FORBIDDEN_FLAGS and RESERVED_FLAGS (aliases and other flags that
 * undo it). Values (tokens without a leading dash) are not inspected.
 */
export function extraArgsProblem(target, adapterArgs, extra) {
  if (!Array.isArray(extra) || !extra.every((a) => typeof a === 'string')) return 'must be an array of strings';
  const adapter = ADAPTERS[target];
  const taken = new Set([
    ...adapterArgs.filter((a) => a.startsWith('-')),
    ...adapter.FORBIDDEN_FLAGS,
    ...(adapter.RESERVED_FLAGS ?? []),
  ]);
  const hit = extra.find((a) => flagNames(a).some((f) => taken.has(f)));
  return hit ? `${hit} is set or refused by severally for this consultant's isolation` : null;
}

/** Extra args go before a trailing `-` (Codex's read-the-prompt-from-stdin marker), else at the end. */
export function withExtraArgs(args, extra) {
  if (extra.length === 0) return args;
  return args.at(-1) === '-' ? [...args.slice(0, -1), ...extra, '-'] : [...args, ...extra];
}

export function assertNoForbiddenFlags(target, args) {
  const forbidden = ADAPTERS[target].FORBIDDEN_FLAGS;
  const hit = args.find((a) => forbidden.includes(a));
  if (hit) throw new Error(`refusing to launch consultant with permission-widening flag ${hit}`);
  // The one read scope any adapter adds: Claude Code's `--add-dir /`, which gives
  // it the same whole-disk read access the other two consultants already have.
  // Any other use -- another target, another directory, a second occurrence --
  // is not something an adapter builds, so it is refused.
  const addDirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
  const allowed = target === 'claude-code' && addDirs.length === 1 && addDirs[0] === '/';
  if (addDirs.length > 0 && !allowed) throw new Error('refusing to widen consultant file access');
  return true;
}
