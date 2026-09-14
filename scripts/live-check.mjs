#!/usr/bin/env node
// Runs a real consultation against the installed CLIs and prints what came
// back. Not part of `npm test` (it spends real quota); run it to verify an
// installation, or to reproduce a failure classification.
//
//   node scripts/live-check.mjs --target antigravity --mode review
//   SEVERALLY_AGY_MODEL=gemini-3.1-pro-high node scripts/live-check.mjs --target antigravity

import { JobManager } from '../src/jobs.mjs';
import { limitsSummary } from '../src/policy.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};

const target = arg('target', 'antigravity');
const mode = arg('mode', 'review');

const REQUESTS = {
  review: {
    mode: 'review',
    question: 'Is a fixed 5-attempt retry with 100ms backoff safe for this client, or will it amplify a downstream outage?',
    objective: 'Ship a retry policy for an internal HTTP client that does not amplify a downstream outage.',
    success_criteria: ['Either a concrete amplification scenario with numbers, or a clear all-clear with the conditions it depends on'],
    constraints: ['No new infrastructure (no queue, no service mesh)', 'Single Node.js service, ~200 requests/second at peak'],
    context: {
      facts: [
        'The client is called from a request handler; a user request blocks on it.',
        'The downstream service has no rate limiting of its own.',
        'The last outage was a 90-second full outage of the downstream service.',
      ],
      proposal: 'Keep the 5 attempts and add full jitter to the 100ms backoff, because the outage we saw was short and jitter should be enough to avoid a synchronised thundering herd.',
      artifacts: [{
        name: 'retryingFetch.ts', kind: 'code', language: 'ts',
        excerpt: 'export async function retryingFetch(url: string) {\n  let lastErr;\n  for (let i = 0; i < 5; i++) {\n    try { return await fetch(url); }\n    catch (err) { lastErr = err; await sleep(100); }\n  }\n  throw lastErr;\n}',
      }],
    },
  },
  explore: {
    mode: 'explore',
    question: 'What are the credible ways to bound p99 write latency here, including framings we may not have considered?',
    objective: 'Keep p99 write latency under 200ms at three times current traffic.',
    context: { facts: ['Writes go straight to Postgres with no batching.', 'Current peak is 200 writes/second, p99 is 180ms.'] },
  },
  debate: {
    mode: 'debate',
    question: 'Write-through or write-behind for the order cache?',
    objective: 'Pick a cache write strategy for the order service.',
    context: {
      facts: ['Order writes peak at 200/s.', 'A lost order is a customer-visible incident.'],
      proposal: 'Write-through: losing an order on a crash is unacceptable, and the latency cost is small.',
      counterpoints: ['Write-behind fronted by a durable append-only log gives the same durability guarantee at lower write latency.'],
    },
  },
};

const request = { target, ...REQUESTS[mode] };

console.log('limits:', JSON.stringify(limitsSummary(), null, 2));
const mgr = new JobManager();
const started = mgr.start(request);
console.log('started:', JSON.stringify(started, null, 2));

const t0 = Date.now();
await mgr.jobs.get(started.job_id).promise;
const view = mgr.view(started.job_id);
console.log(`\n=== finished in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${view.status} ===`);
console.log(JSON.stringify(view, null, 2));
process.exit(view.status === 'completed' ? 0 : 1);
