import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { POLICY, VERDICTS, availableConsultants, configProblem, configWarnings, limitsSummary } from './policy.mjs';
import { requestSchema, RequestError } from './schema.mjs';
import { JobManager, pointsOf } from './jobs.mjs';
import { exportChain, ExportError } from './export.mjs';

/** @typedef {import('@modelcontextprotocol/server').CallToolResult} CallToolResult */

export const SEVERALLY_VERSION = '2.11.0';

// consult_get waits this long when no wait_ms is given: a call that forgot it
// would otherwise return at once and be repeated. Up to 45 s, under the 60 s
// some clients allow a tool call -- unless this client's own registration
// raised the limit (SEVERALLY_MAX_WAIT_MS), which says the client waits that
// long. The config file is shared by every client, so it cannot say that.
const DEFAULT_WAIT_MS = process.env.SEVERALLY_MAX_WAIT_MS ? POLICY.maxWaitMs : Math.min(POLICY.maxWaitMs, 45_000);
// While consult_get waits, the client hears from it this often: a client that
// counts silence against the call keeps it open.
const PROGRESS_EVERY_MS = 15_000;

/** @param {string} v */
const semver = (v) => String(v).split('.').map(Number);
/**
 * @param {string} a
 * @param {string} b
 */
const older = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) {
    const [p, q] = [x[i], y[i]];
    if (p === undefined || q === undefined) return false;
    if (p !== q) return p < q;
  }
  return false;
};

/**
 * The other installed copies of severally, when one runs a different version
 * from this server: a fix reaches a client only through the copy it runs, and
 * an operator who updated one copy cannot see that another is behind. Only
 * version strings are compared. A copy that is missing is not reported.
 * @param {string} [home]
 * @param {string} [severallyHome]
 */
export function staleInstall(home = os.homedir(), severallyHome = POLICY.home) {
  /** @param {string} file */
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  // The runtime's version is read from its bundle, which every install mode
  // replaces; its package.json is written by plugin installs only.
  const bundle = read(path.join(severallyHome, 'runtime', 'severally-mcp.mjs'));
  const plugin = read(path.join(home, '.claude', 'skills', 'severally', '.claude-plugin', 'plugin.json'));
  const found = {
    // This release names it SEVERALLY_VERSION; older ones only had it in the server info.
    runtime: bundle?.match(/(?:SEVERALLY_VERSION = |name: ["']severally["'], version: )["'](\d+\.\d+\.\d+)["']/)?.[1],
    claude_skills_dir: (() => {
      if (plugin === null) return undefined;
      try {
        return JSON.parse(plugin).version;
      } catch {
        return undefined;
      }
    })(),
  };
  /** @type {Record<string, string>} */
  const copies = { this_server: SEVERALLY_VERSION };
  // Only plain x.y.z is compared; anything else is left out rather than guessed at.
  for (const [name, v] of Object.entries(found)) if (v !== undefined && /^\d+\.\d+\.\d+$/.test(v)) copies[name] = v;
  const versions = Object.values(copies);
  if (versions.every((v) => v === SEVERALLY_VERSION)) return null;
  const newest = versions.reduce((a, b) => (older(a, b) ? b : a));
  return {
    copies,
    behind: Object.entries(copies)
      .filter(([, v]) => older(v, newest))
      .map(([k]) => k),
    fix:
      `bring every copy to ${newest}: run \`npx -y severally-mcp@${newest} install\` (or \`node scripts/install.mjs\` from a checkout of that version) ` +
      '(it updates the runtime and the ~/.claude/skills copy), run `/plugin marketplace update severally` for a ' +
      'marketplace install, then restart the clients',
  };
}

const SERVER_INSTRUCTIONS = `Get independent advice from fresh Codex, Claude Code, Antigravity or OpenCode CLI sessions.
Use for important decisions, close alternatives or stalled investigations, or when asked.
Routine: consult_start -> consult_get until finished -> verify a deciding claim -> consult_record once -> report.
Report each actual model, stance, point ID, grounds, your check and decision; retain differing conclusions.
A failure is no advice. Agreement is not evidence; confirmed is verification, not adoption.
The brief and exposed files reach each model. File read boundaries vary by CLI; see each answer's boundary.
Writes, MCP and further agents are denied. Codex has a read-only shell. network: off disables web access.
A chain permits ${POLICY.maxRounds} rounds; spend follow-ups on deciding divergences.`;

const startDescription = `Start one consultant (target) or several (targets); returns job_id or group_id immediately.
Available (name: CLI, model):
${
  availableConsultants()
    .map((c) => `          ${c.name}: ${c.cli}, ${c.model}`)
    .join('\n') || '          (none -- no consultant CLI is installed)'
}
Pass the user's name/CLI/vendor/model wording; target_ambiguous lists candidates, target_unavailable lists available ones.
targets: ["all"] asks every available consultant, including your CLI (marked same lineage). Each gets an identical
brief; one concurrency seat each. Model and limits are operator-owned.
followup_to: completed job_id or group_id; only question is also needed. Inherits the prior inputs; explicit fields,
even empty, replace them. Files are recopied in their current state; add expose_paths or set expose_from_parent: false.
retry_of: failed job_id alone replays saved inputs in a new chain, with current files and a link to the failure.
Use successful group answers first; retry only failed members after fixing auth/quota causes. No other request fields.
mode defaults from context: facts = explore, proposal = review, proposal + counterpoints = debate.
For code: expose_diff: { repo, base? } for changes, expose_paths: [absolute paths] for relevant callers, tests and config.
Files are copied read-only, secrets masked; symlinks/protected paths skipped. Caps: 20 entries, 500 files, 5 MB.
Inspect files_exposed and the manifest; missing premises stay unknown. Other context: facts, artifacts (logs/test output).
network: on/off controls web access, not model submission or local reads; boundary states CLI-specific enforcement.
caller/caller_model identify you; initiator: user only when asked. Optional prediction: { expected, worry } stays local.`;

// One consultation's record: the single form of consult_record, and each
// element of its `records`.
const recordShape = {
  job_id: z.string().min(1).describe('the job_id consult_get returned'),
  entries: z
    .array(
      z.object({
        id: z.string().min(1).describe('f1, u1, c1 ... from the result'),
        verdict: z.enum(VERDICTS),
        effect: z.string().max(4000).optional().describe('what it changed, or why it is unverified'),
        note: z.string().max(4000).optional().describe('what you checked and found'),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  reflection: z
    .object({
      delta: z.string().min(1).max(4000).describe('what the answer added over what you expected ("nothing new" counts)'),
      related_item_ids: z.array(z.string().min(1)).max(50).optional().describe('f1, u1, c1 ...'),
    })
    .optional()
    .describe('written after reading the answer'),
};

/** @param {unknown} err */
const errorMessage = (err) =>
  String((typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined) ?? err);

export function createServer(manager = new JobManager()) {
  // Read once: the copies on disk change only when someone reinstalls, and then
  // this server is the one to restart.
  const stale = staleInstall();
  const server = new McpServer({ name: 'severally', version: SEVERALLY_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  /**
   * @param {unknown} payload
   * @returns {CallToolResult}
   */
  const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
  /**
   * @param {unknown} payload
   * @returns {CallToolResult}
   */
  const fail = (payload) => ({
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  });

  server.registerTool(
    'consult_start',
    {
      title: 'Start a peer consultation',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: startDescription,
      inputSchema: z.object({ request: requestSchema }),
    },
    async ({ request }) => {
      try {
        const started = manager.start(request);
        return ok(stale ? { ...started, stale_install: stale } : started);
      } catch (err) {
        if (err instanceof RequestError) {
          return fail({ error: err.code, message: err.message, details: err.details ?? null, limits: limitsSummary() });
        }
        return fail({ error: 'internal_error', message: errorMessage(err) });
      }
    },
  );

  server.registerTool(
    'consult_get',
    {
      title: 'Get consultation status or result',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        `Wait for job_id or group_id (default ${DEFAULT_WAIT_MS} ms; wait_ms: 0 polls). Repeat while running; ` +
        'progress is sent every 15 s. completed has advice; failed has failure.kind and no advice. ' +
        'A group includes statuses and comparison.by_target: actual model, stance, concrete recommendation, conditions, points/grounds, redaction observations and truncation markers. Null observations are unknown; matching stances need not recommend the same action. ' +
        'Read grounds already present. For missing/shortened deciding points use job_id + ids: ["f2", "u1"]; ' +
        'job_id alone gets one whole answer. detail: full adds the brief/question. ' +
        'Check deciding claims, batch checked entries in consult_record, then report; unchecked points stay unverified.',
      inputSchema: z.object({
        job_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
        wait_ms: z.number().int().min(0).max(POLICY.maxWaitMs).optional(),
        detail: z.enum(['full']).optional(),
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .optional()
          .describe(
            'with job_id: return only these points of the finished answer (f1, u1, c1 ...), each whole with its grounds and, under `recorded`, the verdict you wrote',
          ),
      }),
    },
    async ({ job_id, group_id, wait_ms, detail, ids }, ctx) => {
      if (Boolean(job_id) === Boolean(group_id)) {
        return fail({ error: 'invalid_request', message: 'pass exactly one of job_id or group_id' });
      }
      if (ids && (group_id || detail)) {
        return fail({
          error: 'invalid_request',
          message: "ids goes with job_id alone: a point id belongs to one consultant's answer",
        });
      }
      const req = ctx?.mcpReq;
      const token = req?._meta?.progressToken;
      let beats = 0;
      const timer =
        token === undefined
          ? null
          : setInterval(() => {
              beats += 1;
              req
                .notify({
                  method: 'notifications/progress',
                  params: { progressToken: token, progress: beats, message: 'the consultation is still running' },
                })
                .catch(() => {});
            }, PROGRESS_EVERY_MS);
      let view;
      try {
        // A request the client cancels stops the wait with it. Without group_id,
        // job_id is set: exactly one of the two was checked above.
        view = group_id
          ? await manager.waitGroup(group_id, wait_ms ?? DEFAULT_WAIT_MS, { detail }, req?.signal)
          : await manager.wait(/** @type {string} */ (job_id), wait_ms ?? DEFAULT_WAIT_MS, { detail }, req?.signal);
      } finally {
        clearInterval(timer ?? undefined);
      }
      if (!view) {
        return fail({
          error: 'unknown_job',
          message: `no consultation with ${group_id ? 'group_id' : 'job_id'} "${group_id ?? job_id}"`,
        });
      }
      // Still running: the poll answer as it is; ids applies once there is an answer.
      if (!ids || ['running', 'queued', 'cancelling'].includes(view.status)) return ok(view);
      try {
        // ids comes with job_id alone (checked above), so this is one job's view.
        return ok(pointsOf(/** @type {import('./jobs.mjs').JobView} */ (view), ids));
      } catch (err) {
        if (err instanceof RequestError) return fail({ error: err.code, message: err.message });
        throw err;
      }
    },
  );

  server.registerTool(
    'consult_cancel',
    {
      title: 'Cancel a running consultation',
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Stop a running consultation (job_id) or fan-out (group_id). Other severally servers receive a stop request. ' +
        'The process tree is signalled where the platform permits; on Windows descendants may survive if the CLI already exited.',
      inputSchema: z.object({
        job_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
      }),
    },
    async ({ job_id, group_id }) => {
      if (Boolean(job_id) === Boolean(group_id)) {
        return fail({ error: 'invalid_request', message: 'pass exactly one of job_id or group_id' });
      }
      // Without group_id, job_id is set: exactly one of the two was checked above.
      const view = group_id ? manager.cancelGroup(group_id) : manager.cancel(/** @type {string} */ (job_id));
      if (!view) {
        return fail({
          error: 'unknown_job',
          message: `no consultation with ${group_id ? 'group_id' : 'job_id'} "${group_id ?? job_id}"`,
        });
      }
      return ok(view);
    },
  );

  server.registerTool(
    'consult_record',
    {
      title: 'Record what checking a point showed',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Save checks against point IDs from consult_get: f1 (finding), u1 (unknown), c1 (next check). ' +
        'verdict = confirmed/refuted/not_applicable/unverifiable/unverified; effect = decision impact; note = checked inputs, environment, evidence and limits. ' +
        'Confirmed is not adoption; refuted means the claim did not hold in the recorded check. Partial checks stay unverified with their scope in note. Record only checked points; same ID replaces its entry. ' +
        'Use records: [{ job_id, entries, reflection? }, ...] for one fan-out batch. Invalid jobs/IDs prevent every write; ' +
        'write failures appear per job in results. Saved history survives restart; verdict/effect and bounded new evidence notes go to follow-ups. Legacy notes remain local until recorded again. ' +
        'Optional reflection describes what the answer added over your prediction.',
      inputSchema: z.object({
        ...recordShape,
        job_id: recordShape.job_id.optional(),
        records: z
          .array(z.object(recordShape))
          .min(1)
          .max(POLICY.maxConcurrent)
          .optional()
          .describe('one per fan-out member, instead of job_id/entries/reflection'),
      }),
    },
    async ({ job_id, entries, reflection, records }) => {
      try {
        if (records !== undefined) {
          /** @type {Record<string, unknown>} */
          const out = manager.record(
            Object.fromEntries(Object.entries({ job_id, entries, reflection, records }).filter(([, v]) => v !== undefined)),
          );
          return out.not_saved ? fail(out) : ok(out);
        }
        if (!job_id)
          return fail({ error: 'invalid_request', message: 'pass job_id (with entries and/or reflection), or records' });
        return ok(
          manager.record({
            job_id,
            ...(entries === undefined ? {} : { entries }),
            ...(reflection === undefined ? {} : { reflection }),
          }),
        );
      } catch (err) {
        if (err instanceof RequestError) {
          return fail({ error: err.code, message: err.message, details: err.details ?? null });
        }
        return fail({ error: 'internal_error', message: errorMessage(err) });
      }
    },
  );

  server.registerTool(
    'consult_export',
    {
      title: 'Export a consultation as a record to commit',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        'Render one consultation (chain_id) or fan-out (group_id) as Markdown: the brief as sent, each answer as ' +
        'it came back, and verdicts on each point. Starts with verified points/effects/evidence and unverified count; no inferred adoption or scoring. ' +
        'The text is returned, not written: put it beside the code the decision is about. Reads the history, so ' +
        "an earlier session's consultation can be exported.",
      inputSchema: z.object({
        chain_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
      }),
    },
    async ({ chain_id, group_id }) => {
      try {
        return ok(exportChain({ chain_id, group_id }));
      } catch (err) {
        if (err instanceof ExportError) return fail({ error: err.code, message: err.message });
        return fail({ error: 'internal_error', message: errorMessage(err) });
      }
    },
  );

  server.registerTool(
    'consult_list',
    {
      title: 'List recent consultations',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Recent consultations, earlier sessions' too (this_session is false), newest first, with their ids, " +
        'status, summary, verdicts, latest_completed_job_id and rounds_remaining. Optional target, question ' +
        '(case-insensitive substring), chain_id filters apply before limit. usage_totals is the tokens/cost reported this session, ' +
        'retries included. A figure a CLI does not report is named under not_reported, not counted as zero.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        target: z.string().trim().min(1).max(120).optional(),
        question: z.string().trim().min(1).max(4000).optional(),
        chain_id: z.string().trim().min(1).max(80).optional(),
      }),
    },
    async ({ limit, target, question, chain_id }) => {
      try {
        return ok({
          jobs: manager.list({
            limit: limit ?? 20,
            ...(target === undefined ? {} : { target }),
            ...(question === undefined ? {} : { question }),
            ...(chain_id === undefined ? {} : { chain_id }),
          }),
          usage_totals: manager.usageTotals(),
          limits: limitsSummary(),
        });
      } catch (err) {
        if (err instanceof RequestError) return fail({ error: err.code, message: err.message });
        return fail({ error: 'internal_error', message: errorMessage(err) });
      }
    },
  );

  return { server, manager };
}

export async function main() {
  // A config mistake is said here, at start, as well as on every refused
  // consult_start: the operator may be the only one who reads stderr.
  const problem = configProblem();
  if (problem)
    process.stderr.write(`severally: config needs fixing; every consultation will be refused until it is -- ${problem}\n`);
  for (const w of configWarnings())
    process.stderr.write(`severally: config mistake; the consultant or CLI it is in stays unused until it is fixed -- ${w}\n`);
  if (availableConsultants().length === 0) {
    process.stderr.write(
      'severally: no consultant CLI found on PATH (codex / claude / agy / opencode); every consultation will be refused\n',
    );
  }
  if (process.env.SEVERALLY_ACTIVE === '1') {
    process.stderr.write('severally: refusing to start inside a severally consultant session (recursion barrier)\n');
    process.exit(2);
  }
  // One manager for the process; serveStdio builds the server once the client's
  // opening message has picked the protocol era (2025-era initialize, or 2026-07-28).
  const manager = new JobManager();

  // Close out what an earlier process left running when it died, so its
  // consultations read as interrupted rather than running forever.
  manager.sweepInterrupted();

  let closing = false;
  /** @param {string} signal */
  const bye = async (signal) => {
    if (closing) return;
    closing = true;
    await manager.shutdown();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('exit', () => manager.killNow());

  serveStdio(() => createServer(manager).server);
}
