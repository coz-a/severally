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
  try { fs.chmodSync(home, 0o700); } catch { /* best effort */ }
  return home;
}

export function jobDir(jobId) {
  return path.join(POLICY.home, 'jobs', jobId);
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
export function loadRound(jobId) {
  const historyDir = path.join(POLICY.home, 'history');
  let row = null;
  for (const line of readIfExists(path.join(historyDir, 'index.jsonl')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.job_id === jobId) { row = parsed; break; }
    } catch { /* a damaged line is skipped, not fatal */ }
  }
  if (!row) return null;
  const file = path.join(historyDir, row.chain_id, `round-${String(row.round).padStart(2, '0')}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// `appendIndex: false` rewrites a round that has already been recorded -- the
// lead adding a verdict to it later. index.jsonl stays one line per
// consultation, so counting rounds there never counts edits.
export function persistRound(record, { appendIndex = true } = {}) {
  const dir = path.join(POLICY.home, 'history', record.chain_id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, `round-${String(record.round).padStart(2, '0')}.json`),
    JSON.stringify(record, null, 2),
    { mode: 0o600 },
  );
  if (!appendIndex) return;
  fs.appendFileSync(
    path.join(POLICY.home, 'history', 'index.jsonl'),
    `${JSON.stringify({
      job_id: record.job_id,
      chain_id: record.chain_id,
      round: record.round,
      target: record.target,
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

// A fan-out is recorded as its own record so a later reader can tell which
// answers were asked the same question at the same time; each member job still
// writes its own round file under its own chain.
export function persistGroup(group) {
  const dir = path.join(POLICY.home, 'history', 'groups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${group.group_id}.json`), JSON.stringify(group, null, 2), { mode: 0o600 });
}

// An offer the user turned down never becomes a consultation, so it has no
// round file. Without a line of its own the history would only ever hold the
// offers that were taken, and could not say whether offering is working.
export function appendOffer(entry) {
  const dir = path.join(POLICY.home, 'history');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, 'offers.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function countOffers(outcome) {
  let count = 0;
  for (const line of readIfExists(path.join(POLICY.home, 'history', 'offers.jsonl')).split('\n')) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).outcome === outcome) count += 1;
    } catch { /* a damaged line is skipped, not fatal */ }
  }
  return count;
}

export function cleanupJobDir(jobId) {
  try { fs.rmSync(jobDir(jobId), { recursive: true, force: true }); } catch { /* best effort */ }
}
