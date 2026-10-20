import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { POLICY, VERDICTS, availableConsultants, configProblem, limitsSummary } from './policy.mjs';
import { requestSchema, RequestError } from './schema.mjs';
import { JobManager, pointsOf } from './jobs.mjs';
import { exportChain, ExportError } from './export.mjs';

export const SEVERALLY_VERSION = '2.0.0';

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

const startDescription = `Start a consultation with another agent (or several, via targets). Returns a job_id (or a group_id for several) immediately; the work runs in the background.

target: which consultant to ask. This machine can reach (name: CLI, model):
${availableConsultants().map((c) => `          ${c.name}: ${c.cli}, ${c.model}`).join('\n') || '          (none -- no consultant CLI is installed)'}
        Pass the name the user used: a consultant's name, its CLI ("codex", "agy"), its vendor ("openai") or
        its model ("glm", "claude opus", "gpt-6.1"). A name that fits several consultants goes to the
        operator's ranking first, then to the higher tier (opus over sonnet) and the newer version; when
        nothing separates them it is refused with the candidates -- ask the user which one, do not guess.
        A consultant that is not listed above is refused up front, so do not retry it -- say which ones
        are available instead.
        Consulting your own CLI on a fresh session is encouraged -- it sheds this session's history and
        drift -- and the result is marked as same lineage.
targets: ask several consultants the same question at once (mutually exclusive with target, no duplicates).
        targets: ["all"] asks every consultant listed above; "all" cannot be mixed with names.
        Every member gets the byte-identical brief (on a follow-up, plus its own earlier rounds) and one
        group_id; poll it with consult_get({ group_id }). Each member takes one slot of the concurrency cap,
        and a fan-out that would go over it is refused before any member starts.
        A follow-up (followup_to) to a job names that one consultant. followup_to a group_id, with no target or
        targets, asks every member of that fan-out the same new question, each on its own chain from its latest
        round; a member that is still running, never answered or has used its rounds is skipped and listed.
caller: optional -- the CLI you are running in ("codex" / "claude-code" / "antigravity" / "opencode"), so the
        server can annotate a same-vendor consultation.
caller_model: optional -- the model you are running on (e.g. "claude-opus-5"), self-declared and never checked.
        With it, a same-vendor caveat can say "same lineage, different model" and the record keeps who asked
        whom; it never changes which model the consultant runs.
initiator: optional -- "user" when the user asked for this consultation; leave it out when you started it
        yourself. Self-declared, never checked, gates nothing; it lets the record tell the two apart.
mode: optional. Left out, it is read from context: no proposal is explore, a proposal is review, a proposal
        with counterpoints is debate; a follow-up keeps its chain's mode. To gather opinions without showing
        yours, leave context.proposal empty.
  explore - hand over objective/constraints/facts and withhold your own preferred solution, to get independent
            options, alternative problem framings and blind spots. context.proposal MUST be empty on round 1.
  review  - hand over your current proposal AND the reasoning behind it, to get weaknesses, counterexamples,
            concrete improvements and the conditions under which it holds. context.proposal is required.
  debate  - hand over the disputed point, your position (context.proposal), the other side's claims
            (context.counterpoints) and the extra evidence, to get what would change the judgement, how to test
            it, and which disagreements remain. Both are required.

The consultant starts in an empty working directory and is not told where your repository is, so it sees your
code only if you hand it over in this call. When the question is about code in a repository on this machine,
name the files it is about by absolute path in context.expose_paths: those files and directories are copied
read-only into its working directory (under ./workspace) and are then the only part of your repository it has.
At most 20 entries, 500 files and 5 MB in total; symlinks and protected files are skipped rather than copied,
and text files are credential-masked exactly as the brief is. A directory inside a git work tree copies only the
files git lists (tracked, or untracked and not ignored), so a repository root fits; outside git, .git and
node_modules are skipped. A follow-up starts in a fresh working directory
with no files: pass context.expose_from_parent: true to copy again, as they are now, the paths the round it follows
exposed (a changed or vanished entry is marked; an earlier expose_diff brings back the files it touched, not the
diff), and add expose_paths for anything new. It is never implied: leave it off when the follow-up does not need them. Put the facts it needs into context.facts, and keep
context.artifacts for what is not a file here (test output, a log); an excerpt there goes alongside the
exposed files, not instead of them. For a change you are making, pass
context.expose_diff: { repo: "<absolute repository path>", base?: "<revision, default HEAD>" } instead or as
well: the diff goes in the brief and every file it touches is copied under ./workspace/repo/ at its repository
path. Model, permissions, round count, timeout and size
caps are fixed by this server and cannot be raised from a request.

network: optional -- "on" (default) or "off". "off" takes web search and browsing away from every consultant
        in this round: use it when the brief holds material that must not leave the machine through a URL.
        Whatever the setting, consultants are refused credential and history paths (~/.ssh, cloud keys, other
        tools' sessions, severally's own history, .env files) where the CLI can enforce it; each answer's
        \`boundary\` says what held for that consultant.

prediction: optional -- { expected, worry }: the bottom line you expect back and, in one sentence, what you are
        most worried about. Stored with the consultation and NEVER sent to the consultant. It can only be
        written here, before the consultant runs, so that afterwards you cannot rewrite what you thought
        beforehand; consult_record takes the other half (reflection) once you have read the answer.`;

// One consultation's record: the single form of consult_record, and each
// element of its `records`.
const recordShape = {
  job_id: z.string().min(1).describe('the consultation to record against -- the job_id consult_get returned for it'),
  entries: z.array(z.object({
    id: z.string().min(1).describe('the point this verdict is about: f1, u1, c1 ... as returned in the result'),
    verdict: z.enum(VERDICTS),
    effect: z.string().max(4000).optional().describe('what it changed about your decision, or why it is still unverified'),
    note: z.string().max(4000).optional().describe('what you checked and what you found'),
  })).min(1).max(100).optional(),
  reflection: z.object({
    delta: z.string().min(1).max(4000).describe('what the answer added over what you already expected -- including "nothing new", which is a real outcome'),
    related_item_ids: z.array(z.string().min(1)).max(50).optional().describe('the points this is about: f1, u1, c1 ...'),
  }).optional().describe('written after you have read the answer. There is deliberately no hit/miss label: a point you predicted can still arrive with the evidence that settles it, and a surprise can still be wrong.'),
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
        `Fetch the state of a consultation. It waits up to ${DEFAULT_WAIT_MS} ms for it to finish before ` +
        'answering, a limit set to stay under this client\'s tool-call timeout; wait_ms sets another wait, and ' +
        'wait_ms: 0 answers at once. While it waits it sends a progress notification every 15 s if you asked ' +
        'for them, and a call you cancel stops waiting. A typical consultation takes one to ten minutes; call ' +
        'this again while it runs, and pass a shorter wait_ms when you have independent work to do in between. ' +
        'A completed job carries the structured ' +
        'answer; a failed one carries failure.kind (timeout, auth, usage_limit, rate_limited, model_unavailable, ' +
        'invalid_output, cli_error, spawn_error, interrupted) — that is "no advice was obtained", which is different from advice that arrived ' +
        'with thin evidence (see quality.evidence_basis). ' +
        'Pass group_id instead of job_id to fetch a fan-out; the wait then covers every consultant in it. ' +
        'A fan-out comes back sized to read in one go: each member is its status, failure and job_id, and ' +
        '`comparison.by_target` holds every consultant\'s stance, summary and findings (with their ids) side by ' +
        'side, cut to fixed lengths where `truncated` says so. consult_get({ job_id, ids: ["f2", "u1"] }) on a ' +
        'member returns just those points, each whole with its grounds and your verdict (`recorded`): fetch every point you ' +
        'mean to adopt, that decides your call, that rests on thin grounds, or that every consultant assumes -- ' +
        'not only where they diverge. consult_get({ job_id }) returns the whole answer. A finished ' +
        'consultation names its brief (size, sha256, round file) rather than repeating it; detail: "full" ' +
        'returns the brief, and for a fan-out every member\'s full answer.',
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
        'Write your own verdict against one or more points of an answer, after you have checked them in the '
        + 'repository. Ids come from the result: findings are f1, f2 ..., unknowns u1 ..., next_checks c1 ... . '
        + 'verdict says what checking showed -- "confirmed" (it holds here), "not_applicable" (true in general, '
        + 'not for this codebase), "unverifiable" (cannot be settled with what you can reach), "unverified" (not '
        + 'checked yet, and say in effect why not). It does not say whether you adopted the point. effect is what '
        + 'it changed about your decision; note is the evidence you used. A follow-up to this job shows the '
        + 'consultant each point\'s verdict and effect (credential-masked, like the brief), never the note. '
        + 'Recording the same id again replaces '
        + 'that entry. This server stores what you write and counts the verdicts; it never infers one, and never '
        + 'decides a consultation was worth it. The entry is saved beside the answer and the brief in '
        + '~/.severally/history, which is what makes the decision readable a month from now; the job is '
        + 'read back from that history, so a consultation from an earlier session can still be recorded against. '
        + 'It answers with counts (the verdicts tallied, and how many points now carry one); consult_get reads '
        + 'the entries back. Pass `reflection` to record what the answer added over what you already expected, when the '
        + 'consultation was started with a `prediction`. A prediction itself cannot be written here: it goes '
        + 'in consult_start, before the consultant runs, which is the only thing that makes it a prediction. '
        + 'For a fan-out, record every member in one call: records: [{ job_id, entries, reflection? }, ...] in '
        + 'place of job_id/entries/reflection. Every record is checked first; if any job or id is wrong, nothing is '
        + 'written and each bad one is named. A job whose write fails is listed under results with its error, '
        + 'not counted as saved.',
      inputSchema: z.object({
        ...recordShape,
        job_id: recordShape.job_id.optional(),
        records: z.array(z.object(recordShape)).min(1).max(POLICY.maxConcurrent).optional()
          .describe('several consultations at once -- one per member of a fan-out -- instead of job_id/entries/reflection'),
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
        'Render one consultation (chain_id) or one fan-out (group_id) as Markdown: the brief as it was sent, '
        + 'each consultant\'s answer as it came back, and the verdicts recorded against each point -- with the '
        + 'ones nobody checked marked as unchecked. Nothing is summarised across consultants and nothing is '
        + 'scored. The text is returned, not written: put it wherever the decision belongs in the repository '
        + '(a decision record next to the code it is about), which is the only place a teammate will find it. '
        + 'Reads the on-disk history, so a consultation from an earlier session can still be exported.',
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
        'Recent consultations from this session, newest first, with their status, one-line summary and who '
        + 'asked for them (initiator), and usage_totals: the token (and, where the CLI reports one, cost) figures each consultant reported this '
        + 'session, summed per consultant over every attempt, automatic re-runs included. A figure a CLI does not '
        + 'report is not counted as zero; it is named under not_reported.',
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
