import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { POLICY, limitsSummary } from './policy.mjs';
import { requestSchema, RequestError } from './schema.mjs';
import { JobManager } from './jobs.mjs';

const SERVER_INSTRUCTIONS = `peer-consult lets you get a genuinely independent opinion from the other coding agent
(Codex <-> Claude Code). Each consultation runs in a fresh child session of the other CLI: it can search and
browse the web, it cannot edit files, run commands, or consult anyone else, and it never sees your session --
only the brief you send.

Use it for decisions that deserve a second mind: an architectural or irreversible choice, two options that
look genuinely close, or an investigation that has stalled. Do not use it for routine edits.

Flow: consult_start(request) -> job_id; consult_get(job_id) until it is done; consult_cancel(job_id) to stop it.
Budget is 1 initial round plus at most ${POLICY.maxRounds - 1} follow-ups per chain, and follow-ups should be
spent only on the specific points where you and the consultant actually diverge. Agreement is not evidence:
check the grounds behind a point before you adopt it, and record what you adopted, rejected or held, and why.`;

const startDescription = `Start one consultation with the other agent. Returns a job_id immediately; the work runs in the background.

target: "codex" (ask Codex) or "claude-code" (ask Claude Code).
mode:
  explore - hand over objective/constraints/facts and withhold your own preferred solution, to get independent
            options, alternative problem framings and blind spots. context.proposal MUST be empty on round 1.
  review  - hand over your current proposal AND the reasoning behind it, to get weaknesses, counterexamples,
            concrete improvements and the conditions under which it holds. context.proposal is required.
  debate  - hand over the disputed point, your position (context.proposal), the other side's claims
            (context.counterpoints) and the extra evidence, to get what would change the judgement, how to test
            it, and which disagreements remain. Both are required.

The consultant cannot read your filesystem: put every fact it needs into context.facts and paste the relevant
passages into context.artifacts. Model, permissions, round count, timeout and size caps are fixed by this
server and cannot be raised from a request.`;

export function createServer(manager = new JobManager()) {
  const server = new McpServer(
    { name: 'peer-consult', version: '1.0.0' },
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
        'with thin evidence (see quality.evidence_basis).',
      inputSchema: {
        job_id: z.string().min(1),
        wait_ms: z.number().int().min(0).max(POLICY.maxWaitMs).optional(),
      },
    },
    async ({ job_id, wait_ms }) => {
      const view = await manager.wait(job_id, wait_ms ?? 0);
      if (!view) return fail({ error: 'unknown_job', message: `no consultation with job_id "${job_id}"` });
      return ok(view);
    },
  );

  server.registerTool(
    'consult_cancel',
    {
      title: 'Cancel a running consultation',
      description: 'Stop a running consultation and kill the consultant process and everything it spawned.',
      inputSchema: { job_id: z.string().min(1) },
    },
    async ({ job_id }) => {
      const view = manager.cancel(job_id);
      if (!view) return fail({ error: 'unknown_job', message: `no consultation with job_id "${job_id}"` });
      return ok(view);
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
