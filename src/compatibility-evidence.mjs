// Common record for explicitly run CLI compatibility checks. The job's model
// is the launch selection, never proof of the provider's effective model.
import os from 'node:os';
import fs from 'node:fs';
import { execCommandSync } from './platform.mjs';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** @typedef {{ status: 'passed' | 'failed' | 'inconclusive' | 'not_run', detail: string }} Check */
/** @typedef {{ value: string, source: string }} Observation */
/** @typedef {'consultation' | 'read' | 'forbidden_operations' | 'followup' | 'cancel'} CheckName */

/**
 * @param {string} command
 * @returns {string | null}
 */
export function cliVersion(command) {
  try {
    const out = execCommandSync(command, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

/**
 * @param {{ runner: string,
 * consultant: { name: string, cli: string, model: string, effort: string | null },
 * cliVersion?: string | null,
 * view?: { job_id: string, status: string, model: string | null, result?: unknown },
 * observed?: { model?: Observation, effort?: Observation },
 * checks?: Partial<Record<CheckName, Check>> }} input
 */
export function compatibilityEvidence(input) {
  /** @type {Record<CheckName, Check>} */
  const checks = {
    consultation: { status: 'not_run', detail: 'no consultation result' },
    read: { status: 'not_run', detail: 'not exercised' },
    forbidden_operations: { status: 'not_run', detail: 'not exercised' },
    followup: { status: 'not_run', detail: 'not exercised' },
    cancel: { status: 'not_run', detail: 'not exercised' },
  };
  if (input.view)
    checks.consultation = {
      status: input.view.status === 'completed' ? 'passed' : 'failed',
      detail: `job ${input.view.job_id}: ${input.view.status}`,
    };
  Object.assign(checks, input.checks);
  return {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    runner: input.runner,
    severally_version: version,
    runtime: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
    consultant: input.consultant.name,
    cli: { name: input.consultant.cli, version: input.cliVersion ?? null },
    configured: { model: input.consultant.model, effort: input.consultant.effort },
    launched: { model: input.view?.model ?? null },
    observed: { model: input.observed?.model ?? null, effort: input.observed?.effort ?? null },
    observation_note: 'configured and launched values do not establish the effective model or effort; null means not observed',
    job_id: input.view?.job_id ?? null,
    checks,
  };
}
