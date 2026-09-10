import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { POLICY, VERDICTS, availableTargets, configProblem, limitsSummary } from './policy.mjs';
import { requestSchema, RequestError } from './schema.mjs';
import { JobManager } from './jobs.mjs';
import { exportChain, ExportError } from './export.mjs';

const SERVER_INSTRUCTIONS = `peer-consult lets you get a genuinely independent opinion from another coding agent:
Codex, Claude Code or Antigravity (Gemini). Each consultation runs in a fresh child session of that CLI: it can
search and browse the web, it cannot edit files, run commands, load MCP tools, or consult anyone else, and it
never sees your session -- only the brief you send.

Use it for decisions that deserve a second mind: an architectural or irreversible choice, two options that
look genuinely close, or an investigation that has stalled. Do not use it for routine edits.

Flow: consult_start(request) -> job_id; consult_get(job_id) until it is done; consult_cancel(job_id) to stop it.
Budget is 1 initial round plus at most ${POLICY.maxRounds - 1} follow-ups per chain, and follow-ups should be
spent only on the specific points where you and the consultant actually diverge. Agreement is not evidence:
check the grounds behind a point before you adopt it, and record what you adopted, rejected or held, and why.`;

const startDescription = `Start a consultation with another agent (or several, via targets). Returns a job_id (or a group_id for several) immediately; the work runs in the background.

target: which consultant to ask. This machine can reach: ${availableTargets().join(', ') || '(none -- no consultant CLI is installed)'}.
        The everyday names work too: gpt/chatgpt/openai, claude/anthropic, gemini/agy/google. A consultant that
        is not in that list is refused up front, so do not retry it -- say which ones are available instead.
        Consulting your own CLI is allowed but is a fresh-context check rather than an independent opinion,
        and the result says so.
targets: ask up to 3 consultants the same question at once (mutually exclusive with target, no duplicates).
        Every member gets the byte-identical brief and one group_id; poll it with consult_get({ group_id }).
        A follow-up (followup_to) always names one consultant -- fan-out is never available on a follow-up.
        A consultant may name the model to run it on as a suffix: "claude:claude-opus-5". What each
        consultant is allowed to run is set by the operator, and this server currently allows:
${availableTargets().map((t) => `          ${t}: ${POLICY.targets[t].allowedModels.join(', ')}`).join('\n')}
        Only pass a model when the user asked for one; a name outside the list is refused before the
        consultation starts, and a name matching two of them is refused rather than guessed.
caller: optional -- the CLI you are running in ("codex" / "claude-code" / "antigravity"), so the server can
        annotate a same-vendor consultation.
mode:
  explore - hand over objective/constraints/facts and withhold your own preferred solution, to get independent
            options, alternative problem framings and blind spots. context.proposal MUST be empty on round 1.
  review  - hand over your current proposal AND the reasoning behind it, to get weaknesses, counterexamples,
            concrete improvements and the conditions under which it holds. context.proposal is required.
  debate  - hand over the disputed point, your position (context.proposal), the other side's claims
            (context.counterpoints) and the extra evidence, to get what would change the judgement, how to test
            it, and which disagreements remain. Both are required.

The consultant starts in an empty working directory and is not told where your repository is: put every fact
it needs into context.facts and paste the relevant passages into context.artifacts. Model, permissions, round
count, timeout and size caps are fixed by this server and cannot be raised from a request.`;

export function createServer(manager = new JobManager()) {
  const server = new McpServer(
    { name: 'peer-consult', version: '1.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
  const fail = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true });

  server.registerTool(
    'consult_start',
    {
      title: 'Start a peer consultation',
      description: startDescription,
      inputSchema: { request: requestSchema },
    },
    async ({ request }) => {
      try {
        return ok(manager.start(request));
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
      description:
        'Fetch the state of a consultation. Pass wait_ms to block until it finishes (capped at ' +
        `${POLICY.maxWaitMs} ms, which stays under the request timeout MCP clients apply) instead of polling ` +
        'in a tight loop; a typical consultation takes one to five minutes, so expect to call this several ' +
        'times, and do something else in between. A completed job carries the structured ' +
        'answer; a failed one carries failure.kind (timeout, auth, usage_limit, model_unavailable, invalid_output, ' +
        'cli_error, spawn_error) — that is "no advice was obtained", which is different from advice that arrived ' +
        'with thin evidence (see quality.evidence_basis). ' +
        'Pass group_id instead of job_id to fetch a fan-out; wait_ms then waits for every consultant in it.',
      inputSchema: {
        job_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
        wait_ms: z.number().int().min(0).max(POLICY.maxWaitMs).optional(),
      },
    },
    async ({ job_id, group_id, wait_ms }) => {
      if (Boolean(job_id) === Boolean(group_id)) {
        return fail({ error: 'invalid_request', message: 'pass exactly one of job_id or group_id' });
      }
      const view = group_id
        ? await manager.waitGroup(group_id, wait_ms ?? 0)
        : await manager.wait(job_id, wait_ms ?? 0);
      if (!view) {
        return fail({ error: 'unknown_job', message: `no consultation with ${group_id ? 'group_id' : 'job_id'} "${group_id ?? job_id}"` });
      }
      return ok(view);
    },
  );

  server.registerTool(
    'consult_cancel',
    {
      title: 'Cancel a running consultation',
      description:
        'Stop a running consultation and kill the consultant process and everything it spawned. ' +
        'Pass group_id instead of job_id to stop every consultant in a fan-out.',
      inputSchema: {
        job_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
      },
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
      description:
        'Write your own verdict against one or more points of an answer, after you have checked them in the '
        + 'repository. Ids come from the result: findings are f1, f2 ..., unknowns u1 ..., next_checks c1 ... . '
        + 'verdict says what checking showed -- "confirmed" (it holds here), "not_applicable" (true in general, '
        + 'not for this codebase), "unverifiable" (cannot be settled with what you can reach), "unverified" (not '
        + 'checked yet, and say in effect why not). It does not say whether you adopted the point. effect is what '
        + 'it changed about your decision; note is the evidence you used. Recording the same id again replaces '
        + 'that entry. This server stores what you write and counts the verdicts; it never infers one, and never '
        + 'decides a consultation was worth it. The entry is saved beside the answer and the brief in '
        + '~/.peer-consult/history, which is what makes the decision readable a month from now.',
      inputSchema: {
        job_id: z.string().min(1),
        entries: z.array(z.object({
          id: z.string().min(1).describe('the point this verdict is about: f1, u1, c1 ... as returned in the result'),
          verdict: z.enum(VERDICTS),
          effect: z.string().max(4000).optional().describe('what it changed about your decision, or why it is still unverified'),
          note: z.string().max(4000).optional().describe('what you checked and what you found'),
        })).min(1).max(100),
      },
    },
    async ({ job_id, entries }) => {
      try {
        return ok(manager.record({ job_id, entries }));
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
      description:
        'Render one consultation (chain_id) or one fan-out (group_id) as Markdown: the brief as it was sent, '
        + 'each consultant\'s answer as it came back, and the verdicts recorded against each point -- with the '
        + 'ones nobody checked marked as unchecked. Nothing is summarised across consultants and nothing is '
        + 'scored. The text is returned, not written: put it wherever the decision belongs in the repository '
        + '(a decision record next to the code it is about), which is the only place a teammate will find it. '
        + 'Reads the on-disk history, so a consultation from an earlier session can still be exported.',
      inputSchema: {
        chain_id: z.string().min(1).optional(),
        group_id: z.string().min(1).optional(),
      },
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
      description: 'Recent consultations from this session, newest first, with their status and one-line summary.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit }) => ok({ jobs: manager.list({ limit: limit ?? 20 }), limits: limitsSummary() }),
  );

  return { server, manager };
}

export async function main() {
  // A malformed config file would otherwise run the machine on defaults the
  // operator believes they overrode.
  const problem = configProblem();
  if (problem) process.stderr.write(`peer-consult: ignoring unreadable config -- ${problem}\n`);
  if (availableTargets().length === 0) {
    process.stderr.write(
      'peer-consult: no consultant CLI found on PATH (codex / claude / agy); every consultation will be refused\n',
    );
  }
  if (process.env.PEER_CONSULT_ACTIVE === '1') {
    process.stderr.write(
      'peer-consult: refusing to start inside a peer-consult consultant session (recursion barrier)\n',
    );
    process.exit(2);
  }
  const { server, manager } = createServer();
  const transport = new StdioServerTransport();

  const bye = (signal) => {
    manager.shutdown();
    setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 200).unref();
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('exit', () => manager.shutdown());

  await server.connect(transport);
}
