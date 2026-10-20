// On-disk history. Everything written here has already been through redact():
// the request text on the way in (jobs.mjs stores job.question redacted), the
// consultant's answer on the way out (parse-result.mjs), and every failure
// message and detail (jobs.mjs #fail).

import fs from 'node:fs';
import path from 'node:path';
import { POLICY } from './policy.mjs';

export function ensureDirs() {
  const home = POLICY.home;
  fs.mkdirSync(path.join(home, 'history'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'jobs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'homes'), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(home, 0o700); } catch { /* best effort */ }
  return home;
}

export function jobDir(jobId) {
  return path.join(POLICY.home, 'jobs', jobId);
}

// Synthesised HOMEs (Antigravity, OpenCode) live apart from the job
// directories, under one root: a consultant's read rules can then refuse that
// one directory, including homes created after it started. Codex's permission
// profile cannot express a wildcard such as jobs/*/home.
export function sandboxHome(jobId) {
  return path.join(POLICY.home, 'homes', jobId);
}

export function makeWorkdir(jobId) {
  // Empty, dedicated, and outside any project: nothing for the consultant to
  // pick up as ambient context (no AGENTS.md / CLAUDE.md / repo files).
  const dir = path.join(jobDir(jobId), 'work');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writeJobArtifact(jobId, name, content) {
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}

export function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// A consultation from an earlier server session, found through the index and
// read back from its round file. Verdicts are written after the checking, and
// the checking can take days, so the record must not depend on the job still
// being in this process's memory. Returns null when the index has no such job.
function indexRow(jobId) {
  for (const line of readIfExists(path.join(POLICY.home, 'history', 'index.jsonl')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.job_id === jobId) return parsed;
    } catch { /* a damaged line is skipped, not fatal */ }
  }
  return null;
}

/** Every row of the history index, in the order written; a damaged line is skipped. */
export function indexRows() {
  return readIfExists(path.join(POLICY.home, 'history', 'index.jsonl')).split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

/** The round file an index row points at, or null. */
export function loadRoundAt(row) {
  try { return JSON.parse(fs.readFileSync(roundPath(row.chain_id, row.round), 'utf8')); } catch { return null; }
}

export const roundPath = (chainId, round) =>
  path.join(POLICY.home, 'history', chainId, `round-${String(round).padStart(2, '0')}.json`);

/** Kept beside the round when a consultant did not end on its own; `text` is already redacted. */
export function writeDiagnostics(chainId, round, text) {
  fs.mkdirSync(path.join(POLICY.home, 'history', chainId), { recursive: true, mode: 0o700 });
  const file = roundPath(chainId, round).replace(/\.json$/, '.diagnostics.txt');
  fs.writeFileSync(file, text.slice(-1_000_000), { mode: 0o600 });
  return file;
}

export function loadRound(jobId) {
  const row = indexRow(jobId);
  if (!row) return null;
  try { return JSON.parse(fs.readFileSync(roundPath(row.chain_id, row.round), 'utf8')); } catch { return null; }
}

// Every round file of one chain, oldest first: a follow-up to a consultation
// from an earlier server session needs the rounds before it, not just one.
export function loadChain(chainId) {
  const dir = path.join(POLICY.home, 'history', chainId);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^round-\d+\.json$/.test(n)).sort(); } catch { return []; }
  return names.flatMap((n) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))]; } catch { return []; }
  });
}

// `appendIndex: false` rewrites a round that has already been recorded -- the
// lead adding a verdict to it later. index.jsonl stays one line per
// consultation, so counting rounds there never counts edits.
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
const runningFile = (jobId) => path.join(runningDir(), `${jobId}.json`);

export function writeRunning(record) {
  if (!JOB_ID.test(record.job_id)) return;
  fs.mkdirSync(runningDir(), { recursive: true, mode: 0o700 });
  // Written aside and renamed in, so a reader in another process never sees half a file.
  const tmp = `${runningFile(record.job_id)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, runningFile(record.job_id));
}

export function loadRunning(jobId) {
  if (!JOB_ID.test(jobId)) return null;
  try { return JSON.parse(fs.readFileSync(runningFile(jobId), 'utf8')); } catch { return null; }
}

export function listRunning() {
  try {
    return fs.readdirSync(runningDir()).map((n) => n.replace(/\.json$/, '')).filter((id) => JOB_ID.test(id));
  } catch { return []; }
}

export function removeRunning(jobId) {
  if (!JOB_ID.test(jobId)) return;
  try { fs.rmSync(runningFile(jobId), { force: true }); } catch { /* best effort */ }
}

// Seats: the concurrency cap is shared by every severally process on one
// ~/.severally, so a consultation holds a seat file there from admission to
// finish. Seats are counted and taken under one short lock, so two processes
// admitting at once cannot both see the last free seat. `held(seat)` says
// whether a seat's owner is still running it; one that is not is removed.
const seatsDir = () => path.join(POLICY.home, 'slots');
const seatFile = (jobId) => path.join(seatsDir(), `${jobId}.json`);
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

function withSeatLock(fn) {
  const lock = path.join(seatsDir(), '.lock');
  fs.mkdirSync(seatsDir(), { recursive: true, mode: 0o700 });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Held for a few file operations at most: one this old was left by a
      // process that died holding it.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock); } catch { /* gone already */ }
      if (Date.now() > until) throw new Error('the seat lock stayed taken; try again');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* best effort */ } }
}

/** Takes one seat per entry of `seats` ({ job_id, owner }), all or none. */
export function takeSeats(seats, cap, held) {
  return withSeatLock(() => {
    const live = [];
    for (const name of fs.readdirSync(seatsDir())) {
      if (!name.endsWith('.json')) continue;
      let seat = null;
      try { seat = JSON.parse(fs.readFileSync(path.join(seatsDir(), name), 'utf8')); } catch { /* half-written or damaged: free */ }
      if (seat && held(seat)) live.push(seat);
      else try { fs.rmSync(path.join(seatsDir(), name), { force: true }); } catch { /* best effort */ }
    }
    // A chain runs one round at a time, across processes: a live seat on the
    // same chain, or a round file already at the number chosen, means another
    // server continued it first.
    for (const mine of seats.filter((x) => x.chain_id)) {
      let other = live.find((x) => x.chain_id === mine.chain_id);
      if (!other && fs.existsSync(roundPath(mine.chain_id, mine.round))) {
        try { other = { job_id: JSON.parse(fs.readFileSync(roundPath(mine.chain_id, mine.round), 'utf8')).job_id, round: mine.round }; } catch { other = { job_id: '(unreadable)', round: mine.round }; }
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

export function releaseSeat(jobId) {
  if (!JOB_ID.test(jobId)) return;
  try { fs.rmSync(seatFile(jobId), { force: true }); } catch { /* best effort */ }
}

export function loadGroup(groupId) {
  if (!GROUP_ID.test(groupId)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(POLICY.home, 'history', 'groups', `${groupId}.json`), 'utf8')); } catch { return null; }
}

// A fan-out is recorded as its own record so a later reader can tell which
// answers were asked the same question at the same time; each member job still
// writes its own round file under its own chain.
export function persistGroup(group) {
  const dir = path.join(POLICY.home, 'history', 'groups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${group.group_id}.json`), JSON.stringify(group, null, 2), { mode: 0o600 });
}

export function cleanupJobDir(jobId) {
  for (const dir of [jobDir(jobId), sandboxHome(jobId)]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
