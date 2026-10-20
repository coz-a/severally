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

export const SEVERALLY_VERSION = '2.1.0';

// consult_get waits this long when no wait_ms is given: a call that forgot it
// would otherwise return at once and be repeated. Up to 45 s, under the 60 s
// some clients allow a tool call -- unless this client's own registration
// raised the limit (SEVERALLY_MAX_WAIT_MS), which says the client waits that
// long. The config file is shared by every client, so it cannot say that.
const DEFAULT_WAIT_MS = process.env.SEVERALLY_MAX_WAIT_MS ? POLICY.maxWaitMs : Math.min(POLICY.maxWaitMs, 45_000);
// While consult_get waits, the client hears from it this often: a client that
// counts silence against the call keeps it open.
const PROGRESS_EVERY_MS = 15_000;

const semver = (v) => String(v).split('.').map(Number);
const older = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };

/**
 * The other installed copies of severally, when one runs a different version
 * from this server: a fix reaches a client only through the copy it runs, and
 * an operator who updated one copy cannot see that another is behind. Only
 * version strings are compared. A copy that is missing is not reported.
 */
export function staleInstall(home = os.homedir(), severallyHome = POLICY.home) {
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  // The runtime's version is read from its bundle, which every install mode
  // replaces; its package.json is written by plugin installs only.
  const bundle = read(path.join(severallyHome, 'runtime', 'severally-mcp.mjs'));
  const plugin = read(path.join(home, '.claude', 'skills', 'severally', '.claude-plugin', 'plugin.json'));
  const found = {
    // This release names it SEVERALLY_VERSION; older ones only had it in the server info.
    runtime: bundle?.match(/(?:SEVERALLY_VERSION = |name: ["']severally["'], version: )["'](\d+\.\d+\.\d+)["']/)?.[1],
    claude_skills_dir: (() => { try { return JSON.parse(plugin).version; } catch { return undefined; } })(),
  };
  const copies = { this_server: SEVERALLY_VERSION };
  // Only plain x.y.z is compared; anything else is left out rather than guessed at.
  for (const [name, v] of Object.entries(found)) if (/^\d+\.\d+\.\d+$/.test(v ?? '')) copies[name] = v;
  const versions = Object.values(copies);
  if (versions.every((v) => v === SEVERALLY_VERSION)) return null;
  const newest = versions.reduce((a, b) => (older(a, b) ? b : a));
  return {
    copies,
    behind: Object.keys(copies).filter((k) => older(copies[k], newest)),
    fix: `bring every copy to ${newest}: run \`npx -y severally-mcp@${newest} install\` (or \`node scripts/install.mjs\` from a checkout of that version) `
      + '(it updates the runtime and the ~/.claude/skills copy), run `/plugin marketplace update severally` for a '
      + 'marketplace install, then restart the clients',
  };
}

const SERVER_INSTRUCTIONS = `severally lets you get a genuinely independent opinion from another coding agent:
Codex, Claude Code, Antigravity or OpenCode, each on the models the operator set up as consultants.
Each consultation runs in a fresh child session of that CLI: it can read files and search and browse the web;
it cannot edit files, change anything on the system (Codex may run read-only commands), load MCP tools, start
other agents or consult anyone else, and it never sees your session -- only the brief you send.

Use it for decisions that deserve a second mind: an architectural or irreversible choice, two options that
look genuinely close, or an investigation that has stalled. Do not use it for routine edits.

Flow: consult_start(request) -> job_id; consult_get(job_id) until it is done; consult_cancel(job_id) to stop it.
Budget is 1 initial round plus at most ${POLICY.maxRounds - 1} follow-ups per chain, and follow-ups should be
spent only on the specific points where you and the consultant actually diverge. Agreement is not evidence:
check the grounds behind a point before you adopt it, and record what you adopted, rejected or held, and why.`;

const startDescription = `Start a consultation with another agent (or several, via targets). Returns a job_id (or a group_id for several) at once; the work runs in the background.

target: which consultant to ask. This machine can reach (name: CLI, model):
${availableConsultants().map((c) => `          ${c.name}: ${c.cli}, ${c.model}`).join('\n') || '          (none -- no consultant CLI is installed)'}
        Pass the word the user used: a name, a CLI ("codex", "agy"), a vendor or a model ("claude opus"). One
        that fits several, unresolved by the operator's ranking, tier and version, is refused with the
        candidates (target_ambiguous); one not listed is refused (target_unavailable). Your own CLI on a fresh
        session is a valid consultant, marked same lineage.
targets: several consultants, the same question (not with target, no duplicates); targets: ["all"] is every
        consultant listed above. Every member gets the byte-identical brief (a follow-up adds its own earlier rounds) and one group_id, for consult_get
        and consult_cancel. A fan-out over the concurrency cap is refused before any member starts.
followup_to: the job_id of the answer to continue, or a group_id to ask every member of that fan-out again
        (each on its own chain; a member that cannot take one is skipped and listed). A follow-up needs only
        followup_to and question: the consultant, mode, objective, constraints, success_criteria, facts,
        proposal, counterpoints and artifacts are the earlier round's unless you pass them, and one you pass,
        even empty, replaces it. Files are not carried over: context.expose_from_parent: true copies again,
        as they are now, what the earlier round exposed. A job's follow-up cannot change the consultant.
mode: optional, read from context when left out: no proposal is explore, a proposal is review, a proposal with
        counterpoints is debate. review and debate need context.proposal (your plan and its reasoning); debate
        also needs context.counterpoints (the other side's claims); explore refuses a proposal on round 1.
context: the consultant starts in an empty working directory and is not told where your repository is, so
        give it at least one of: facts, artifacts (material that is not a file here: test output, a log),
        expose_paths (absolute paths copied read-only under ./workspace; a directory in a git work tree copies
        the files git lists; at most 20 entries, 500 files, 5 MB; symlinks and protected files are skipped,
        text is credential-masked like the brief), expose_diff: { repo, base? } (the diff in the brief, the
        files it touches under ./workspace/repo/).
network: "on" (default) or "off" (no web search or browsing for any consultant this round). Credential and
        history paths are refused either way where the CLI can enforce it; each answer's \`boundary\` says what held.
caller, caller_model: the CLI and model you run on (self-declared), for the same-vendor caveat and the record.
initiator: "user" when the user asked for this; leave it out when you started it yourself.
prediction: { expected, worry }, kept and never sent; it can only be written here, before the answer.
Model, permissions, rounds, timeout and size caps are fixed by this server.`;

// One consultation's record: the single form of consult_record, and each
// element of its `records`.
const recordShape = {
  job_id: z.string().min(1).describe('the job_id consult_get returned'),
  entries: z.array(z.object({
    id: z.string().min(1).describe('f1, u1, c1 ... from the result'),
    verdict: z.enum(VERDICTS),
    effect: z.string().max(4000).optional().describe('what it changed, or why it is unverified'),
    note: z.string().max(4000).optional().describe('what you checked and found'),
  })).min(1).max(100).optional(),
  reflection: z.object({
    delta: z.string().min(1).max(4000).describe('what the answer added over what you expected ("nothing new" counts)'),
    related_item_ids: z.array(z.string().min(1)).max(50).optional().describe('f1, u1, c1 ...'),
  }).optional().describe('written after reading the answer'),
};

export function createServer(manager = new JobManager()) {
  // Read once: the copies on disk change only when someone reinstalls, and then
  // this server is the one to restart.
  const stale = staleInstall();
  const server = new McpServer(
    { name: 'severally', version: SEVERALLY_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
  const fail = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true });

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
        return fail({ error: 'internal_error', message: String(err?.message ?? err) });
      }
    },
  );

  server.registerTool(
    'consult_get',
    {
      title: 'Get consultation status or result',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        `Fetch a consultation's state or answer. It waits up to ${DEFAULT_WAIT_MS} ms (under this client's tool-call ` +
        'timeout) for it to finish; wait_ms sets another wait, 0 answers at once. While waiting it sends a progress ' +
        'notification every 15 s when asked; a cancelled call stops waiting. Most take one to ten minutes: call ' +
        'again while status is running. completed carries the structured answer; failed carries ' +
        'failure.kind (timeout, auth, usage_limit, rate_limited, model_unavailable, invalid_output, cli_error, ' +
        'spawn_error, interrupted), meaning no advice was obtained -- not the same as advice with thin evidence ' +
        '(quality.evidence_basis, quality.caveat). group_id fetches a fan-out: each member\'s status, failure and ' +
        'job_id, and `comparison.by_target` with every stance, summary and finding id side by side, cut where ' +
        '`truncated` says so. ids: ["f2", "u1"] with a job_id returns just those points, whole, with their grounds ' +
        'and your verdict (`recorded`). A finished consultation names its brief rather than repeating it; detail: ' +
        '"full" returns the brief, and for a fan-out every member\'s full answer.',
      inputSchema: z.object({
        job_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
        wait_ms: z.number().int().min(0).max(POLICY.maxWaitMs).optional(),
        detail: z.enum(['full']).optional(),
        ids: z.array(z.string().min(1)).min(1).max(100).optional()
          .describe('with job_id: return only these points of the finished answer (f1, u1, c1 ...), each whole with its grounds and, under `recorded`, the verdict you wrote'),
      }),
    },
    async ({ job_id, group_id, wait_ms, detail, ids }, ctx) => {
      if (Boolean(job_id) === Boolean(group_id)) {
        return fail({ error: 'invalid_request', message: 'pass exactly one of job_id or group_id' });
      }
      if (ids && (group_id || detail)) {
        return fail({ error: 'invalid_request', message: 'ids goes with job_id alone: a point id belongs to one consultant\'s answer' });
      }
      const req = ctx?.mcpReq;
      const token = req?._meta?.progressToken;
      let beats = 0;
      const timer = token === undefined ? null : setInterval(() => {
        beats += 1;
        req.notify({ method: 'notifications/progress', params: { progressToken: token, progress: beats, message: 'the consultation is still running' } })
          .catch(() => {});
      }, PROGRESS_EVERY_MS);
      let view;
      try {
        // A request the client cancels stops the wait with it.
        view = group_id
          ? await manager.waitGroup(group_id, wait_ms ?? DEFAULT_WAIT_MS, { detail }, req?.signal)
          : await manager.wait(job_id, wait_ms ?? DEFAULT_WAIT_MS, { detail }, req?.signal);
      } finally {
        clearInterval(timer);
      }
      if (!view) {
        return fail({ error: 'unknown_job', message: `no consultation with ${group_id ? 'group_id' : 'job_id'} "${group_id ?? job_id}"` });
      }
      // Still running: the poll answer as it is; ids applies once there is an answer.
      if (!ids || ['running', 'queued', 'cancelling'].includes(view.status)) return ok(view);
      try {
        return ok(pointsOf(view, ids));
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
        'Stop a running consultation and kill the consultant process and everything it spawned. ' +
        'Pass group_id instead of job_id to stop every consultant in a fan-out.',
      inputSchema: z.object({
        job_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
      }),
    },
    async ({ job_id, group_id }) => {
      if (Boolean(job_id) === Boolean(group_id)) {
        return fail({ error: 'invalid_request', message: 'pass exactly one of job_id or group_id' });
      }
      const view = group_id ? manager.cancelGroup(group_id) : manager.cancel(job_id);
      if (!view) {
        return fail({ error: 'unknown_job', message: `no consultation with ${group_id ? 'group_id' : 'job_id'} "${group_id ?? job_id}"` });
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
        'Write your verdict on points of an answer after checking them: ids f1 ... (findings), u1 ... (unknowns), '
        + 'c1 ... (next_checks). verdict is what checking showed -- confirmed (holds here), not_applicable (true in '
        + 'general, not here), unverifiable, unverified (not checked yet; say why in effect) -- not whether you adopted '
        + 'it. effect is what it changed about your decision, note the evidence. A follow-up shows the consultant each '
        + 'verdict and effect (credential-masked), never the note. The same id again replaces the entry. Saved beside '
        + 'the answer in ~/.severally/history, so a job from an earlier session can be recorded against; the server '
        + 'never infers a verdict. Answers with counts; consult_get reads the entries back. reflection records what the '
        + 'answer added over your consult_start prediction. records: [{ job_id, entries, reflection? }, ...] records '
        + 'every member of a fan-out in one call; all are checked first and nothing is written if any job or id is '
        + 'wrong. A job whose write fails is listed under results with its error.',
      inputSchema: z.object({
        ...recordShape,
        job_id: recordShape.job_id.optional(),
        records: z.array(z.object(recordShape)).min(1).max(POLICY.maxConcurrent).optional()
          .describe('one per fan-out member, instead of job_id/entries/reflection'),
      }),
    },
    async ({ job_id, entries, reflection, records }) => {
      try {
        if (records !== undefined) {
          const out = manager.record(Object.fromEntries(Object.entries({ job_id, entries, reflection, records }).filter(([, v]) => v !== undefined)));
          return out.not_saved ? fail(out) : ok(out);
        }
        if (!job_id) return fail({ error: 'invalid_request', message: 'pass job_id (with entries and/or reflection), or records' });
        return ok(manager.record({
          job_id,
          ...(entries === undefined ? {} : { entries }),
          ...(reflection === undefined ? {} : { reflection }),
        }));
      } catch (err) {
        if (err instanceof RequestError) {
          return fail({ error: err.code, message: err.message, details: err.details ?? null });
        }
        return fail({ error: 'internal_error', message: String(err?.message ?? err) });
      }
    },
  );

  server.registerTool(
    'consult_export',
    {
      title: 'Export a consultation as a record to commit',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        'Render one consultation (chain_id) or fan-out (group_id) as Markdown: the brief as sent, each answer as '
        + 'it came back, and the verdicts on each point, unchecked ones marked. Nothing is summarised or scored. '
        + 'The text is returned, not written: put it beside the code the decision is about. Reads the history, so '
        + 'an earlier session\'s consultation can be exported.',
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
        return fail({ error: 'internal_error', message: String(err?.message ?? err) });
      }
    },
  );

  server.registerTool(
    'consult_list',
    {
      title: 'List recent consultations',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        'Recent consultations from this session, newest first: status, one-line summary, initiator; and '
        + 'usage_totals, the tokens (and cost, where the CLI reports one) each consultant reported this session, '
        + 'retries included. A figure a CLI does not report is named under not_reported, not counted as zero.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    },
    async ({ limit }) => ok({
      jobs: manager.list({ limit: limit ?? 20 }),
      usage_totals: manager.usageTotals(),
      limits: limitsSummary(),
    }),
  );

  return { server, manager };
}

export async function main() {
  // A config mistake is said here, at start, as well as on every refused
  // consult_start: the operator may be the only one who reads stderr.
  const problem = configProblem();
  if (problem) process.stderr.write(`severally: config needs fixing; every consultation will be refused until it is -- ${problem}\n`);
  for (const w of configWarnings()) process.stderr.write(`severally: config mistake; the consultant or CLI it is in stays unused until it is fixed -- ${w}\n`);
  if (availableConsultants().length === 0) {
    process.stderr.write(
      'severally: no consultant CLI found on PATH (codex / claude / agy / opencode); every consultation will be refused\n',
    );
  }
  if (process.env.SEVERALLY_ACTIVE === '1') {
    process.stderr.write(
      'severally: refusing to start inside a severally consultant session (recursion barrier)\n',
    );
    process.exit(2);
  }
  // One manager for the process; serveStdio builds the server once the client's
  // opening message has picked the protocol era (2025-era initialize, or 2026-07-28).
  const manager = new JobManager();

  // Close out what an earlier process left running when it died, so its
  // consultations read as interrupted rather than running forever.
  manager.sweepInterrupted();

  let closing = false;
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
