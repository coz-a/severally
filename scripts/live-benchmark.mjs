// Explicit, quota-spending benchmark entry point. A receipt is reserved before
// starting so interrupted trials remain in the denominator as unfinished.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { JobManager } from '../src/jobs.mjs';
import { POLICY, timeoutMs } from '../src/policy.mjs';
import { redact } from '../src/redact.mjs';
import { cliVersion } from '../src/compatibility-evidence.mjs';
import { parseRequest } from '../src/schema.mjs';
import { prepareS3Material, verifyS3Material } from './benchmark-s3.mjs';

/** @param {string[]} argv @param {string} name @returns {string} */
function requiredArg(argv, name) {
  const index = argv.indexOf(`--${name}`);
  const value = argv[index + 1];
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`--${name} is required`);
  return value;
}

/** @param {unknown} value */
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
/** @param {unknown} value */
const nonemptyList = (value) => Array.isArray(value) && value.length > 0 && value.every(nonempty);

// Inferred from the adapter's arguments; this is not a serving receipt.
/** @param {{cli: string, model: string, effort: string | null}} consultant */
export function expectedLaunchEffort(consultant) {
  if (consultant.cli === 'antigravity') return null;
  if (consultant.cli === 'opencode' && consultant.model.includes('#'))
    return consultant.model.slice(consultant.model.indexOf('#') + 1) || null;
  return consultant.effort ?? 'high';
}

/** @param {string[]} argv */
export async function runBenchmark(argv) {
  const manifestPath = requiredArg(argv, 'benchmark-manifest');
  const outputPath = requiredArg(argv, 'output');
  const bytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!['S1', 'S2', 'S3', 'S4'].includes(manifest.scenario)) throw new Error('scenario must be S1, S2, S3 or S4');
  if (!manifest.request || typeof manifest.request !== 'object') throw new Error('request must be provided in the manifest');
  if (!nonemptyList(manifest.useful_conditions) || !nonemptyList(manifest.acceptable_findings))
    throw new Error('useful_conditions and acceptable_findings must be fixed before running');
  if (!nonempty(manifest.cache) || !nonempty(manifest.evaluator) || !nonempty(manifest.material?.description))
    throw new Error('cache, evaluator and material description must be specified');
  if (manifest.scenario === 'S2' && (!Array.isArray(manifest.request.targets) || manifest.request.targets.length < 2))
    throw new Error('S2 requires at least two explicit targets');
  const parsed = parseRequest(manifest.request);
  if (manifest.scenario === 'S1' && parsed.targets.length !== 1) throw new Error('S1 requires exactly one consultant');
  if (manifest.scenario === 'S2' && parsed.targets.length < 2) throw new Error('S2 requires at least two distinct consultants');
  if (manifest.scenario === 'S3' && parsed.targets.length !== 1) throw new Error('S3 requires exactly one consultant');
  if (manifest.scenario === 'S4' && parsed.targets.length !== 1) throw new Error('S4 requires exactly one consultant');
  if (manifest.scenario === 'S4' && !nonempty(manifest.followup_question))
    throw new Error('S4 requires a fixed follow-up question');
  const fixedMaterial = manifest.scenario === 'S3' ? prepareS3Material(manifest) : null;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  /** @type {Record<string, any>} */
  const receipt = {
    schema_version: 1,
    scenario: manifest.scenario,
    manifest_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    route: 'direct_job_manager',
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    outcome: 'in_progress',
    runtime: { platform: process.platform, os_release: os.release(), node: process.version },
    criteria: redact({ useful_conditions: manifest.useful_conditions, acceptable_findings: manifest.acceptable_findings }),
    material: redact(manifest.material),
    cache: redact(manifest.cache),
    evaluator: redact(manifest.evaluator),
    independence_verified: null,
    adoption: null,
    scenario_assessment: null,
    material_verified: null,
    human_actions: null,
    planned_concurrency: Array.isArray(manifest.request.targets) ? manifest.request.targets.length : 1,
    request_bytes: Buffer.byteLength(JSON.stringify(manifest.request), 'utf8'),
    followup: null,
    members: [],
    error: null,
    ...(manifest.scenario === 'S4'
      ? { followup_question_sha256: crypto.createHash('sha256').update(manifest.followup_question).digest('hex') }
      : {}),
  };
  // Avoid overwriting a previous trial: even failures are part of the sample.
  fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  const save = () => {
    const temporary = `${outputPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  };
  /** @type {JobManager | null} */
  let mgr = null;
  try {
    const manager = new JobManager();
    mgr = manager;
    const started = manager.start(manifest.request);
    const members = 'job_id' in started ? [started] : started.jobs;
    receipt.members = members.map((member) => ({
      job_id: member.job_id,
      target: member.target,
      status: 'running',
      cli: member.cli,
      configured_model: member.model,
      configured_effort: null,
      expected_launch_effort: null,
      timeout_ms: null,
      cli_version: null,
      observed_model: null,
      observed_effort: null,
      failure_kind: null,
      duration_ms: null,
      usage: null,
      useful: null,
    }));
    save();
    let materialMismatch = false;
    if (fixedMaterial) {
      try {
        receipt.material_verified = redact(verifyS3Material(fixedMaterial, started));
      } catch (error) {
        materialMismatch = true;
        receipt.material_verified = { verified: false, detail: redact(error instanceof Error ? error.message : String(error)) };
        // The process may already have received its brief. Cancel and keep the
        // trial as failed; do not describe a post-start mismatch as preflight.
        for (const member of members) manager.cancel(member.job_id);
      }
      save();
    }
    await Promise.all(members.map((member) => manager.jobs.get(member.job_id)?.promise));
    receipt.members = members.map((member) => {
      const view = manager.view(member.job_id);
      const consultant = POLICY.consultants.find((c) => c.name === member.target);
      return {
        job_id: member.job_id,
        target: member.target,
        status: view?.status ?? 'unknown',
        cli: member.cli,
        configured_model: consultant?.model ?? member.model,
        configured_effort: consultant?.effort ?? null,
        expected_launch_effort: consultant ? expectedLaunchEffort(consultant) : null,
        expected_launch_effort_source: 'adapter policy; actual CLI arguments not observed',
        timeout_ms: consultant ? timeoutMs(consultant) : null,
        cli_version: consultant ? cliVersion(POLICY.clis[consultant.cli].cli) : null,
        launched_model: view?.model ?? null,
        observed_model: null,
        observed_effort: null,
        failure_kind: view?.failure?.kind ?? null,
        duration_ms: view?.duration_ms ?? null,
        usage: view?.usage ?? null,
        useful: null,
        read_observation: view?.tool_inputs
          ? {
              exposed_files: view.tool_inputs.exposed_files,
              exposed_mentioned: view.tool_inputs.exposed_mentioned,
              note: 'A filename in tool input does not prove the file was read or understood.',
            }
          : null,
      };
    });
    receipt.outcome =
      !materialMismatch && receipt.members.every((/** @type {{status: string}} */ m) => m.status === 'completed')
        ? 'completed'
        : 'failed';
  } catch (error) {
    if (mgr) await mgr.shutdown();
    receipt.outcome = 'failed';
    receipt.error = redact(error instanceof Error ? error.message : String(error));
  }
  receipt.finished_at = new Date().toISOString();
  receipt.duration_ms = Date.now() - startMs;
  if (manifest.scenario === 'S4' && receipt.outcome === 'completed') {
    receipt.job_id = receipt.members[0].job_id;
    receipt.initial_consultation = {
      started_at: receipt.started_at,
      finished_at: receipt.finished_at,
      duration_ms: receipt.duration_ms,
    };
    receipt.finished_at = null;
    receipt.duration_ms = null;
    receipt.outcome = 'awaiting_assessment';
  }
  save();
  console.log(JSON.stringify(receipt));
  return ['completed', 'awaiting_assessment'].includes(receipt.outcome) ? 0 : 1;
}
