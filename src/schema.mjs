// Request validation. Deliberately strict: unknown keys are rejected so a
// caller cannot smuggle in model/permission/limit overrides, and every
// mode-specific protocol rule is enforced here rather than in the prompt.

import { z } from 'zod';
import { POLICY, TARGETS, TARGET_INPUTS, MODES, artifactKinds, resolveTarget } from './policy.mjs';

const L = POLICY.input;
const trimmed = (max, label) =>
  z.string().trim().min(1, `${label} must not be empty`).max(max, `${label} exceeds ${max} characters`);

export const artifactSchema = z
  .object({
    name: trimmed(L.artifactNameMax, 'artifacts[].name'),
    kind: z.enum(artifactKinds),
    language: z.string().trim().max(40).optional(),
    source: z.string().trim().max(500).optional(),
    excerpt: trimmed(L.artifactExcerptMax, 'artifacts[].excerpt'),
  })
  .strict();

export const contextSchema = z
  .object({
    facts: z.array(trimmed(L.factMax, 'context.facts[]')).max(L.factsMax).default([]),
    proposal: z.string().trim().max(L.proposalMax).nullish(),
    counterpoints: z.array(trimmed(L.counterpointMax, 'context.counterpoints[]')).max(L.counterpointsMax).default([]),
    artifacts: z.array(artifactSchema).max(L.artifactsMax).default([]),
  })
  .strict();

// Shared by `target` and `caller`: both accept the same vendor spellings
// (case, spaces/underscores vs. dashes) at the tool boundary.
const normalizeTargetLike = (val) => {
  if (typeof val !== 'string') return val;
  return val.trim().toLowerCase().replace(/[\s_]+/g, '-');
};

export const requestSchema = z
  .object({
    // Exactly one of `target` (one consultant) or `targets` (ask several the
    // same question) is required; parseRequest below enforces the exclusivity,
    // because zod cannot phrase that refusal usefully.
    target: z.preprocess(normalizeTargetLike, z.enum(TARGET_INPUTS)).optional(),
    targets: z
      .array(z.preprocess(normalizeTargetLike, z.enum(TARGET_INPUTS)))
      .min(1)
      .max(TARGETS.length)
      .optional(),
    // Identifies the host CLI making this request, if it names itself. Purely
    // an annotation input for the same-vendor caveat below: it must never
    // gate permissions, limits, rounds, or which CLI gets launched.
    caller: z.preprocess(normalizeTargetLike, z.enum(TARGET_INPUTS)).nullish(),
    mode: z.enum(MODES),
    question: trimmed(L.questionMax, 'question'),
    objective: trimmed(L.objectiveMax, 'objective'),
    success_criteria: z.array(trimmed(L.constraintMax, 'success_criteria[]')).max(L.constraintsMax).default([]),
    constraints: z.array(trimmed(L.constraintMax, 'constraints[]')).max(L.constraintsMax).default([]),
    context: contextSchema.default({ facts: [], counterpoints: [], artifacts: [] }),
    followup_to: z.string().trim().max(80).nullish(),
  })
  .strict();

function charCount(req) {
  let n = req.question.length + req.objective.length;
  for (const c of req.constraints) n += c.length;
  for (const c of req.success_criteria) n += c.length;
  for (const f of req.context.facts) n += f.length;
  for (const c of req.context.counterpoints) n += c.length;
  if (req.context.proposal) n += req.context.proposal.length;
  for (const a of req.context.artifacts) n += a.excerpt.length + a.name.length;
  return n;
}

export class RequestError extends Error {
  constructor(message, code = 'invalid_request', details = undefined) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate + normalise a consult request.
 * `isFollowup` is decided by the caller (the job store resolves followup_to first).
 */
export function parseRequest(raw, { isFollowup = false } = {}) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new RequestError(`request failed validation: ${issues.join('; ')}`, 'invalid_request', issues);
  }
  const req = parsed.data;
  const hasSingle = req.target !== undefined && req.target !== null;
  const hasMany = Array.isArray(req.targets) && req.targets.length > 0;
  if (hasSingle && hasMany) {
    throw new RequestError('pass either target (one consultant) or targets (several), not both', 'invalid_request');
  }
  if (!hasSingle && !hasMany) {
    throw new RequestError(
      `name the consultant: target: "codex" | "claude-code" | "antigravity" (aliases: ${TARGET_INPUTS.join(', ')}), or targets: [...] to ask several the same question`,
      'target_required',
    );
  }
  const resolved = (hasSingle ? [req.target] : req.targets).map((t) => resolveTarget(t));
  const unique = [...new Set(resolved)];
  if (unique.length !== resolved.length) {
    throw new RequestError(
      'the same consultant is named twice; asking one agent the same question twice does not add independence',
      'duplicate_targets',
    );
  }
  if (isFollowup && unique.length > 1) {
    throw new RequestError(
      'a follow-up continues the exchange with one consultant; name exactly one target',
      'followup_fanout_not_allowed',
    );
  }
  req.targets = unique;
  req.target = unique[0]; // single-target consumers (brief, history, adapters) keep working
  req.fanout = unique.length > 1;
  req.caller = resolveTarget(req.caller ?? '') ?? null;
  req.followup_to = req.followup_to ?? null;
  const proposal = (req.context.proposal ?? '').trim();
  req.context.proposal = proposal.length ? proposal : null;

  const total = charCount(req);
  if (total > L.totalCharsMax) {
    throw new RequestError(
      `request payload is ${total} characters, over the ${L.totalCharsMax} character budget; trim artifacts/facts to the passages that matter`,
      'payload_too_large',
    );
  }

  if (req.mode === 'explore' && !isFollowup && req.context.proposal) {
    throw new RequestError(
      'mode "explore" must withhold the lead\'s preferred solution on the first round: leave context.proposal empty (use mode "review" to have a proposal critiqued)',
      'explore_proposal_not_allowed',
    );
  }
  if ((req.mode === 'review' || req.mode === 'debate') && !req.context.proposal) {
    throw new RequestError(
      `mode "${req.mode}" requires context.proposal: the current proposal plus the reasoning behind it`,
      'proposal_required',
    );
  }
  if (req.mode === 'debate' && req.context.counterpoints.length === 0) {
    throw new RequestError(
      'mode "debate" requires context.counterpoints: the opposing claims as their side states them',
      'counterpoints_required',
    );
  }
  if (req.context.facts.length === 0 && req.context.artifacts.length === 0) {
    throw new RequestError(
      'provide at least one entry in context.facts or context.artifacts: the consultant cannot read your filesystem, so every fact it needs must be in the request',
      'context_required',
    );
  }
  return req;
}
