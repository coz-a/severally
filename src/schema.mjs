// Request validation. Deliberately strict: unknown keys are rejected so a
// caller cannot smuggle in model/permission/limit overrides, and every
// mode-specific protocol rule is enforced here rather than in the prompt.

import { z } from 'zod';
import {
  POLICY, TARGETS, TARGET_INPUTS, MODES, STANCES, artifactKinds,
  resolveTarget, resolveModel, availableTargets, unavailableReason, normalizeTargetInput, normalizeTargetSpec, splitTargetSpec,
} from './policy.mjs';

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
// (case, spaces/underscores vs. dashes) at the tool boundary. The rule itself
// comes from policy.mjs, so it cannot drift away from resolveTarget().
const normalizeTargetLike = normalizeTargetInput;

// A consultant, optionally carrying the model to run it on: "claude-code", or
// "claude:claude-opus-5". The bare-name branch keeps every accepted spelling
// visible as an enum in the published tool schema; the suffixed branch is
// checked in parseRequest, where the target is known and its operator
// allowlist can be consulted.
const targetSpec = z.preprocess(
  normalizeTargetSpec,
  z.union(
    [
      z.enum(TARGET_INPUTS),
      // The message lives on this branch because zod surfaces the branch's own
      // error, not the union's: a bare "must match pattern /.../" tells the
      // caller nothing about which names it may use.
      z.string().regex(/^[a-z0-9-]+:.*$/, {
        message: `must be one of: ${TARGET_INPUTS.join(', ')}`
          + ' -- optionally with the model to run it on, e.g. "claude:claude-opus-5"',
      }),
    ],
    // Both branches failing means the value is neither an accepted name nor a
    // name with a model suffix; zod would otherwise report a bare regex
    // mismatch, which tells the caller nothing about what it may say.
    {
      error: () => `must be one of: ${TARGET_INPUTS.join(', ')}`
        + ' -- optionally with the model to run it on, e.g. "claude:claude-opus-5"',
    },
  ),
);

// Who asked for a consultation, as the lead reports it. An offer the user
// declines starts nothing, so it has no value here: it is written by
// consult_offer_declined instead.
export const INITIATORS = ['user', 'offer_accepted'];

export const requestSchema = z
  .object({
    // Exactly one of `target` (one consultant) or `targets` (ask several the
    // same question) is required; parseRequest below enforces the exclusivity,
    // because zod cannot phrase that refusal usefully.
    target: targetSpec.optional(),
    targets: z.array(targetSpec).min(1).max(TARGETS.length).optional(),
    // Identifies the host CLI making this request, if it names itself. Purely
    // an annotation input for the same-vendor caveat below: it must never
    // gate permissions, limits, rounds, or which CLI gets launched.
    caller: z.preprocess(normalizeTargetLike, z.enum(TARGET_INPUTS)).nullish(),
    // The model the host CLI is running on, if it says. Self-declared like
    // `caller`, unverifiable by the server, and used for one thing: so a
    // same-vendor caveat can say "same lineage, different model" (an Opus
    // lead asking Fable) instead of treating every same-vendor call as the
    // same head. Never gates the model launched, which comes from `target`.
    caller_model: trimmed(120, 'caller_model')
      .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'caller_model must be a single line of printable characters')
      .nullish(),
    // Who asked for this consultation, as the lead reports it: the user
    // directly, or the user accepting an offer the lead made at an approval.
    // Self-declared and unverifiable like caller_model, and it never gates
    // anything. It exists so the history can say whether offering works.
    initiator: z.enum(INITIATORS).nullish(),
    mode: z.enum(MODES),
    question: trimmed(L.questionMax, 'question'),
    // Optional: most consultations state what they are after in the question
    // itself, and a second field that repeats it is friction, not information.
    objective: trimmed(L.objectiveMax, 'objective').nullish(),
    success_criteria: z.array(trimmed(L.constraintMax, 'success_criteria[]')).max(L.constraintsMax).default([]),
    constraints: z.array(trimmed(L.constraintMax, 'constraints[]')).max(L.constraintsMax).default([]),
    context: contextSchema.default({ facts: [], counterpoints: [], artifacts: [] }),
    // Written by the lead before the consultant is launched, kept on this
    // machine, and deliberately outside `context`: everything in `context` is
    // rendered into the brief, and this must never be. It is here rather than
    // in a later call so that it cannot be written after the answer is read,
    // which is the only thing that makes it a prediction.
    prediction: z
      .object({
        expected: z.enum(STANCES).describe('the bottom line you expect to come back'),
        worry: trimmed(2000, 'prediction.worry').describe('the one thing you are most worried about, in a sentence'),
      })
      .strict()
      .nullish(),
    followup_to: z.string().trim().max(80).nullish(),
  })
  .strict();

function charCount(req) {
  let n = req.question.length + (req.objective?.length ?? 0);
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
  const named = hasSingle ? [req.target] : req.targets;
  const specs = named.map((t) => splitTargetSpec(t));
  const resolved = specs.map((s) => resolveTarget(s.target));
  // The schema and resolveTarget() share one normaliser, so this should be
  // unreachable -- but if they ever do diverge, an unresolved target would
  // otherwise reach POLICY.targets[null].model and surface as a TypeError
  // dressed up as internal_error. Refuse it as the validation failure it is.
  const unresolved = named.filter((_, i) => resolved[i] === null);
  if (unresolved.length) {
    throw new RequestError(
      `cannot resolve consultant ${unresolved.map((t) => JSON.stringify(t)).join(', ')} to a known target; use one of: ${TARGET_INPUTS.join(', ')}`,
      'unknown_target',
    );
  }
  // A consultant whose CLI is not installed here (or that the operator turned
  // off) is refused now, naming what this machine does have -- rather than
  // costing a slot and coming back as spawn_error minutes later.
  const usable = availableTargets();
  const missing = [...new Set(resolved.filter((t) => !usable.includes(t)))];
  if (missing.length) {
    throw new RequestError(
      `consultant ${missing.map((t) => `${JSON.stringify(t)} (${unavailableReason(t)})`).join(', ')} `
      + 'is not available on this machine; '
      + (usable.length
        ? `available: ${usable.join(', ')}`
        : 'no consultant is available -- install one of the CLIs, or check SEVERALLY_TARGETS'),
      'target_unavailable',
    );
  }

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

  // A model suffix ("claude:claude-opus-5") picks which model that consultant
  // runs on, from the list the operator sanctioned. Resolved here, before any
  // CLI is launched, so a name the operator never allowed is a validation
  // error rather than a consultation that burns a slot and fails.
  const models = {};
  resolved.forEach((target, i) => {
    const wanted = specs[i].model;
    const t = POLICY.targets[target];
    if (wanted === null) {
      models[target] = t.model;
      return;
    }
    if (wanted === '') {
      throw new RequestError(
        `${JSON.stringify(named[i])} ends in ":" without naming a model; drop the colon to use ${t.model}`,
        'model_not_allowed',
      );
    }
    const match = resolveModel(target, wanted);
    if (match === null) {
      throw new RequestError(
        `consultant "${target}" is not configured to run model ${JSON.stringify(wanted)}; `
        + `allowed: ${t.allowedModels.join(', ')}. The operator adds more by setting ${t.allowedModelsEnv}`,
        'model_not_allowed',
      );
    }
    if (match.ambiguous) {
      throw new RequestError(
        `${JSON.stringify(wanted)} matches more than one model allowed for "${target}": `
        + `${match.ambiguous.join(', ')}. Name one of them exactly`,
        'model_ambiguous',
      );
    }
    models[target] = match.model;
  });
  req.modelFor = models;
  req.targets = unique;
  req.target = unique[0]; // single-target consumers (brief, history, adapters) keep working
  req.fanout = unique.length > 1;
  req.caller = resolveTarget(req.caller ?? '') ?? null;
  req.caller_model = req.caller_model ?? null;
  req.initiator = req.initiator ?? null;
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
      'provide at least one entry in context.facts or context.artifacts: the consultant starts in an empty working directory and is not told where your repository is, so every fact it needs must be in the request',
      'context_required',
    );
  }
  return req;
}
