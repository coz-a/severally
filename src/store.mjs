// On-disk history. Everything written here has already been through redact():
// the request text on the way in (jobs.mjs stores job.question redacted), the
// consultant's answer on the way out (parse-result.mjs), and every failure
// message and detail (jobs.mjs #fail).

import fs from 'node:fs';
import path from 'node:path';
import { POLICY } from './policy.mjs';

/**
 * @typedef {object} JobFailure
 * @property {string} kind
 * @property {string} message
 * @property {string | null} detail
 * @property {boolean} retriable
 * @property {boolean} delivered_advice
 */

/**
 * What the lead wrote about one point of an answer.
 * @typedef {object} RecordEntry
 * @property {string} id
 * @property {string} verdict
 * @property {string | null} effect
 * @property {string | null} note
 * @property {string} recorded_at
 */

/**
 * The lead's verdicts on a round. The counts are present in a view
 * (recordSummary), not in what the history keeps.
 * @typedef {object} JobRecord
 * @property {string} updated_at
 * @property {RecordEntry[]} entries
 * @property {Record<string, number> | undefined} [verdicts]
 * @property {{recordable: number, recorded: number} | undefined} [coverage]
 * @property {string[] | undefined} [unrecorded]
 */

/**
 * What the answer added over what the lead expected, in the lead's words.
 * @typedef {object} Reflection
 * @property {string} delta
 * @property {string[]} related_item_ids
 * @property {string} recorded_at
 */

/**
 * Written before the consultant is launched and never sent to it.
 * @typedef {object} Prediction
 * @property {string} expected
 * @property {string} worry
 * @property {string} recorded_at
 */

/** @typedef {import('./parse-result.mjs').ConsultResult} ConsultResult A consultant's normalized answer (see normalizeResult). */
/** @typedef {import('./parse-result.mjs').Finding | import('./parse-result.mjs').Unknown | import('./parse-result.mjs').NextCheck} ResultItem One finding, unknown or next check of an answer. */
/** @typedef {import('./schema.mjs').Mode} Mode */
/** @typedef {import('./run.mjs').Boundary} Boundary What the consultant could and could not do, as its launch set it. */
/** @typedef {import('./run.mjs').UsageRecord} UsageRecord */

/**
 * What the server derived from a normalized answer and the checks around it.
 * @typedef {object} Quality
 * @property {string[]} missing_sections
 * @property {number} findings_without_grounds
 * @property {boolean} unsourced
 * @property {Record<string, number> | undefined} [list_truncated]
 * @property {import('./parse-result.mjs').EvidenceBasis | null | undefined} [evidence_basis]
 * @property {string | null | undefined} [caveat]
 */

/**
 * The material the lead handed over, as the round keeps it (see briefRecord).
 * @typedef {object} BriefRecord
 * @property {string | null} objective
 * @property {string[]} success_criteria
 * @property {string[]} constraints
 * @property {string[]} facts
 * @property {string | null} proposal
 * @property {string[]} counterpoints
 * @property {Array<{name: string, kind: string, language: string | null, source: string | null, excerpt: string}>} artifacts
 * @property {{entries: BriefExposeEntry[], totals: import('./expose-paths.mjs').ExposeTotals, skipped: import('./expose-paths.mjs').SkippedPath[]} | null} expose_paths
 */

/**
 * @typedef {object} BriefExposeEntry
 * @property {number} index
 * @property {string} source
 * @property {string} exposed_as
 * @property {string} kind
 * @property {number} files
 * @property {number} bytes
 * @property {string | null} sha256
 * @property {string | undefined} [base]
 * @property {string[] | undefined} [changes]
 * @property {boolean | undefined} [changed_since_parent]
 */

/**
 * The tail of what a timed-out consultant had written (raw, unparsed).
 * @typedef {object} PartialOutput
 * @property {true} partial
 * @property {number} chars_total
 * @property {boolean} capture_truncated
 * @property {string} tail
 * @property {string} stopped_at
 * @property {string} note
 */

/**
 * One earlier attempt of a consultation that was run again.
 * @typedef {object} RetryRecord
 * @property {string} failure_kind
 * @property {string} reason
 * @property {string} at
 * @property {UsageRecord | null} usage
 */

/**
 * One consultation as the history keeps it (see JobManager#record) and as the
 * process running it describes it; written to history/<chain>/round-NN.json.
 * @typedef {object} Round
 * @property {string} job_id
 * @property {string} chain_id
 * @property {string | null | undefined} [group_id]
 * @property {number} round
 * @property {string} target
 * @property {string} cli
 * @property {string | null | undefined} [vendor]
 * @property {string | null | undefined} [caller]
 * @property {string | null | undefined} [caller_model]
 * @property {string | null | undefined} [initiator]
 * @property {'on' | 'off' | undefined} [network]
 * @property {Boundary | null | undefined} [boundary]
 * @property {RetryRecord[] | undefined} [retries]
 * @property {PartialOutput | null | undefined} [partial_output]
 * @property {Record<string, number> | null | undefined} [tool_calls]
 * @property {string | null | undefined} [diagnostics]
 * @property {Mode} mode
 * @property {string} status
 * @property {string} model
 * @property {string} question
 * @property {BriefRecord | null} brief
 * @property {Prediction | null | undefined} [prediction]
 * @property {Reflection | null | undefined} [reflection]
 * @property {JobRecord | null | undefined} [record]
 * @property {string} created_at
 * @property {string | null} started_at
 * @property {string | null} finished_at
 * @property {number | null} duration_ms
 * @property {ConsultResult | null} result
 * @property {Quality | null} quality
 * @property {UsageRecord | null} usage
 * @property {JobFailure | null} failure
 * @property {number | null | undefined} [references_count]
 * @property {string | null} followup_to
 * @property {number | undefined} [rounds_used]
 * @property {number | undefined} [rounds_remaining]
 */

/** @typedef {Round & { owner?: Seat['owner'] }} RunningRecord The in-progress marker: a round record so far, plus who runs it. */

/**
 * One line of history/index.jsonl.
 * @typedef {object} IndexRow
 * @property {string} job_id
 * @property {string} chain_id
 * @property {number} round
 * @property {string} target
 * @property {string | null} cli
 * @property {string | null} initiator
 * @property {string} mode
 * @property {string} status
 * @property {string | null} failure_kind
 * @property {string} model
 * @property {string} created_at
 * @property {number | null} duration_ms
 */

/**
 * A seat file: one running consultation, shared by every severally process on one home.
 * @typedef {object} Seat
 * @property {string} job_id
 * @property {string | undefined} [chain_id] set on a follow-up: the chain it continues
 * @property {number | undefined} [round] set on a follow-up: the round it opens
 * @property {{ pid: number, deadline_at: string } | undefined} [owner]
 */

/**
 * What takeSeats says: `chainBusy` when the chain already has a round under way,
 * otherwise `live` (the seats held) and, when the cap is hit, `elsewhere`.
 * @typedef {{ ok: true, live: number, elsewhere?: undefined, chainBusy?: undefined }
 *   | { ok: false, live?: undefined, elsewhere?: undefined, chainBusy: { live: Seat, mine: Seat } }
 *   | { ok: false, live: number, elsewhere: number, chainBusy?: undefined }} SeatResult
 */

/**
 * A fan-out, recorded under history/groups/.
 * @typedef {object} Group
 * @property {string} group_id
 * @property {string} created_at
 * @property {Mode} mode
 * @property {string} question
 * @property {string[]} job_ids
 */

export function ensureDirs() {
  const home = POLICY.home;
  fs.mkdirSync(path.join(home, 'history'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'jobs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'homes'), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    /* best effort */
  }
  return home;
}

/** @param {string} jobId */
export function jobDir(jobId) {
  return path.join(POLICY.home, 'jobs', jobId);
}

// Synthesised HOMEs (Antigravity, OpenCode) live apart from the job
// directories, under one root: a consultant's read rules can then refuse that
// one directory, including homes created after it started. Codex's permission
// profile cannot express a wildcard such as jobs/*/home.
/** @param {string} jobId */
export function sandboxHome(jobId) {
  return path.join(POLICY.home, 'homes', jobId);
}

/** @param {string} jobId */
export function makeWorkdir(jobId) {
  // Empty, dedicated, and outside any project: nothing for the consultant to
  // pick up as ambient context (no AGENTS.md / CLAUDE.md / repo files).
  const dir = path.join(jobDir(jobId), 'work');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * @param {string} jobId
 * @param {string} name
 * @param {string | NodeJS.ArrayBufferView} content
 */
export function writeJobArtifact(jobId, name, content) {
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}

/** @param {string} p */
export function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// A consultation from an earlier server session, found through the index and
// read back from its round file. Verdicts are written after the checking, and
// the checking can take days, so the record must not depend on the job still
// being in this process's memory. Returns null when the index has no such job.
/**
 * @param {string} jobId
 * @returns {IndexRow | null}
 */
function indexRow(jobId) {
  for (const line of readIfExists(path.join(POLICY.home, 'history', 'index.jsonl')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.job_id === jobId) return parsed;
    } catch {
      /* a damaged line is skipped, not fatal */
    }
  }
  return null;
}

/**
 * Every row of the history index, in the order written; a damaged line is skipped.
 * @returns {IndexRow[]}
 */
export function indexRows() {
  return readIfExists(path.join(POLICY.home, 'history', 'index.jsonl'))
    .split('\n')
    .flatMap((line) => {
      try {
        const row = line.trim() ? JSON.parse(line) : null;
        return row && typeof row === 'object' && JOB_ID.test(row.job_id) ? [row] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The round file an index row points at, or null.
 * @param {{ chain_id: string, round: number }} row
 * @returns {Round | null}
 */
export function loadRoundAt(row) {
  try {
    return JSON.parse(fs.readFileSync(roundPath(row.chain_id, row.round), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} chainId
 * @param {number} round
 */
export const roundPath = (chainId, round) =>
  path.join(POLICY.home, 'history', chainId, `round-${String(round).padStart(2, '0')}.json`);

/**
 * Kept beside the round when a consultant did not end on its own; `text` is already redacted.
 * @param {string} chainId
 * @param {number} round
 * @param {string} text
 */
export function writeDiagnostics(chainId, round, text) {
  fs.mkdirSync(path.join(POLICY.home, 'history', chainId), { recursive: true, mode: 0o700 });
  const file = roundPath(chainId, round).replace(/\.json$/, '.diagnostics.txt');
  fs.writeFileSync(file, text.slice(-1_000_000), { mode: 0o600 });
  return file;
}

/**
 * @param {string} jobId
 * @returns {Round | null}
 */
export function loadRound(jobId) {
  const row = indexRow(jobId);
  if (!row) return null;
  try {
    return JSON.parse(fs.readFileSync(roundPath(row.chain_id, row.round), 'utf8'));
  } catch {
    return null;
  }
}

// Every round file of one chain, oldest first: a follow-up to a consultation
// from an earlier server session needs the rounds before it, not just one.
/**
 * @param {string} chainId
 * @returns {Round[]}
 */
export function loadChain(chainId) {
  const dir = path.join(POLICY.home, 'history', chainId);
  /** @type {string[]} */
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /^round-\d+\.json$/.test(n))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))];
    } catch {
      return [];
    }
  });
}

// `appendIndex: false` rewrites a round that has already been recorded -- the
// lead adding a verdict to it later. index.jsonl stays one line per
// consultation, so counting rounds there never counts edits.
/**
 * @param {Round} record
 * @param {{ appendIndex?: boolean }} [opts]
 */
export function persistRound(record, { appendIndex = true } = {}) {
  fs.mkdirSync(path.join(POLICY.home, 'history', record.chain_id), { recursive: true, mode: 0o700 });
  // Written aside and renamed into place, so a write that fails part-way
  // leaves the round as it was rather than a damaged file.
  const file = roundPath(record.chain_id, record.round);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // A consultation already in the index is not added again: a round closed out
  // as interrupted can still be finished later by a process that was only
  // slow, and one closed out twice (two servers sweeping at once) is one line.
  if (!appendIndex || indexRow(record.job_id)) return;
  fs.appendFileSync(
    path.join(POLICY.home, 'history', 'index.jsonl'),
    `${JSON.stringify({
      job_id: record.job_id,
      chain_id: record.chain_id,
      round: record.round,
      target: record.target,
      cli: record.cli ?? null,
      initiator: record.initiator ?? null,
      mode: record.mode,
      status: record.status,
      failure_kind: record.failure?.kind ?? null,
      model: record.model,
      created_at: record.created_at,
      duration_ms: record.duration_ms,
    })}\n`,
    { mode: 0o600 },
  );
}

// A consultation still in progress, so another severally process -- several
// share one ~/.severally, one per client session -- or this one after a
// restart can tell "running elsewhere" from "the process running it died".
// The round file is written only when it finishes, and the index stays one
// line per consultation, so the marker lives apart and is removed then.
// Ids reach these paths from the lead's request, so only the shape the server
// mints is accepted: "../" in a job_id must not name a file outside history.
const JOB_ID = /^job_[0-9a-f]{12}$/;
const GROUP_ID = /^group_[0-9a-f]{12}$/;
const runningDir = () => path.join(POLICY.home, 'history', 'running');
/** @param {string} jobId */
const runningFile = (jobId) => path.join(runningDir(), `${jobId}.json`);

/** @param {RunningRecord} record */
export function writeRunning(record) {
  if (!JOB_ID.test(record.job_id)) return;
  fs.mkdirSync(runningDir(), { recursive: true, mode: 0o700 });
  // Written aside and renamed in, so a reader in another process never sees half a file.
  const tmp = `${runningFile(record.job_id)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, runningFile(record.job_id));
}

/**
 * @param {string} jobId
 * @returns {RunningRecord | null}
 */
export function loadRunning(jobId) {
  if (!JOB_ID.test(jobId)) return null;
  try {
    return JSON.parse(fs.readFileSync(runningFile(jobId), 'utf8'));
  } catch {
    return null;
  }
}

/** @returns {string[]} */
export function listRunning() {
  try {
    return fs
      .readdirSync(runningDir())
      .map((n) => n.replace(/\.json$/, ''))
      .filter((id) => JOB_ID.test(id));
  } catch {
    return [];
  }
}

/** @param {string} jobId */
export function removeRunning(jobId) {
  if (!JOB_ID.test(jobId)) return;
  try {
    fs.rmSync(runningFile(jobId), { force: true });
  } catch {
    /* best effort */
  }
}

// Seats: the concurrency cap is shared by every severally process on one
// ~/.severally, so a consultation holds a seat file there from admission to
// finish. Seats are counted and taken under one short lock, so two processes
// admitting at once cannot both see the last free seat. `held(seat)` says
// whether a seat's owner is still running it; one that is not is removed.
const seatsDir = () => path.join(POLICY.home, 'slots');
/** @param {string} jobId */
const seatFile = (jobId) => path.join(seatsDir(), `${jobId}.json`);
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withSeatLock(fn) {
  const lock = path.join(seatsDir(), '.lock');
  fs.mkdirSync(seatsDir(), { recursive: true, mode: 0o700 });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
      // Held for a few file operations at most: one this old was left by a
      // process that died holding it.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock);
      } catch {
        /* gone already */
      }
      if (Date.now() > until) throw new Error('the seat lock stayed taken; try again');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* best effort */
    }
  }
}

/**
 * A seat that continues a chain names it and the round it opens together.
 * @param {Seat} seat
 * @returns {seat is Seat & { chain_id: string, round: number }}
 */
const continuesChain = (seat) => Boolean(seat.chain_id);

/**
 * Takes one seat per entry of `seats` ({ job_id, owner }), all or none.
 * @param {Seat[]} seats
 * @param {number} cap
 * @param {(seat: Seat) => boolean} held
 * @returns {SeatResult}
 */
export function takeSeats(seats, cap, held) {
  return withSeatLock(() => {
    /** @type {Seat[]} */
    const live = [];
    const names = fs.readdirSync(seatsDir());
    // A cancel asked for after its consultation ended has no seat left to go with.
    for (const name of names.filter((n) => n.endsWith('.cancel'))) {
      if (!names.includes(name.replace(/\.cancel$/, '.json')))
        try {
          fs.rmSync(path.join(seatsDir(), name), { force: true });
        } catch {
          /* best effort */
        }
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      /** @type {Seat | null} */
      let seat = null;
      try {
        seat = JSON.parse(fs.readFileSync(path.join(seatsDir(), name), 'utf8'));
      } catch {
        /* half-written or damaged: free */
      }
      if (seat && held(seat)) live.push(seat);
      else
        try {
          fs.rmSync(path.join(seatsDir(), name), { force: true });
        } catch {
          /* best effort */
        }
    }
    // A chain runs one round at a time, across processes: a live seat on the
    // same chain, or a round file already at the number chosen, means another
    // server continued it first.
    for (const mine of seats.filter(continuesChain)) {
      /** @type {Seat | undefined} */
      let other = live.find((x) => x.chain_id === mine.chain_id);
      if (!other && fs.existsSync(roundPath(mine.chain_id, mine.round))) {
        try {
          other = { job_id: JSON.parse(fs.readFileSync(roundPath(mine.chain_id, mine.round), 'utf8')).job_id, round: mine.round };
        } catch {
          other = { job_id: '(unreadable)', round: mine.round };
        }
      }
      if (other) return { ok: false, chainBusy: { live: other, mine } };
    }
    if (live.length + seats.length > cap) {
      return { ok: false, live: live.length, elsewhere: live.filter((x) => x.owner?.pid !== process.pid).length };
    }
    for (const seat of seats) {
      if (!JOB_ID.test(seat.job_id)) throw new Error(`not a job id: ${seat.job_id}`);
      fs.writeFileSync(seatFile(seat.job_id), JSON.stringify(seat), { mode: 0o600, flag: 'wx' });
    }
    return { ok: true, live: live.length };
  });
}

/** @param {string} jobId */
export function releaseSeat(jobId) {
  if (!JOB_ID.test(jobId)) return;
  try {
    fs.rmSync(seatFile(jobId), { force: true });
  } catch {
    /* best effort */
  }
  clearCancel(jobId);
}

// A cancel asked for by a server that does not run the consultation: left
// beside its seat, for the server that does to find and act on.
/** @param {string} jobId */
const cancelFile = (jobId) => path.join(seatsDir(), `${jobId}.cancel`);
/** @param {string} jobId */
export function requestCancel(jobId) {
  if (!JOB_ID.test(jobId)) return false;
  try {
    fs.mkdirSync(seatsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cancelFile(jobId), '', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
/** @param {string} jobId */
export const cancelRequested = (jobId) => JOB_ID.test(jobId) && fs.existsSync(cancelFile(jobId));
/** @param {string} jobId */
export function clearCancel(jobId) {
  if (JOB_ID.test(jobId))
    try {
      fs.rmSync(cancelFile(jobId), { force: true });
    } catch {
      /* best effort */
    }
}

/**
 * @param {string} groupId
 * @returns {Group | null}
 */
export function loadGroup(groupId) {
  if (!GROUP_ID.test(groupId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(POLICY.home, 'history', 'groups', `${groupId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// A fan-out is recorded as its own record so a later reader can tell which
// answers were asked the same question at the same time; each member job still
// writes its own round file under its own chain.
/** @param {Group} group */
export function persistGroup(group) {
  const dir = path.join(POLICY.home, 'history', 'groups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${group.group_id}.json`), JSON.stringify(group, null, 2), { mode: 0o600 });
}

/** @param {string} jobId */
export function cleanupJobDir(jobId) {
  for (const dir of [jobDir(jobId), sandboxHome(jobId)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
