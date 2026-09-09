// On-disk history. Everything written here has already been through redact().

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

export function persistRound(record) {
  const dir = path.join(POLICY.home, 'history', record.chain_id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, `round-${String(record.round).padStart(2, '0')}.json`),
    JSON.stringify(record, null, 2),
    { mode: 0o600 },
  );
  fs.appendFileSync(
    path.join(POLICY.home, 'history', 'index.jsonl'),
    `${JSON.stringify({
      job_id: record.job_id,
      chain_id: record.chain_id,
      round: record.round,
      target: record.target,
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

export function cleanupJobDir(jobId) {
  try { fs.rmSync(jobDir(jobId), { recursive: true, force: true }); } catch { /* best effort */ }
}
