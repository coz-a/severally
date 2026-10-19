// Request validation. Deliberately strict: unknown keys are rejected so a
// caller cannot smuggle in model/permission/limit overrides, and every
// mode-specific protocol rule is enforced here rather than in the prompt.

import { z } from 'zod';
import path from 'node:path';
import {
  POLICY, CALLER_INPUTS, MODES, STANCES, artifactKinds,
  resolveCaller, availableConsultants, consultantAvailable, unavailableReason,
} from './policy.mjs';
import { normalizeName, resolveConsultant } from './consultants.mjs';

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

// An absolute path on the machine this server runs on. Relative is refused
// rather than resolved: relative-to-what has no answer once the value has
// crossed from the lead's process into this one. Whether it exists is
// settled later, by the walk that has to stat it anyway.
const exposedPathSchema = z
  .string()
  .trim()
  .min(1, 'context.expose_paths[] must not be empty')
  .max(1_000, 'context.expose_paths[] exceeds 1000 characters')
  .refine((p) => path.isAbsolute(p), { message: 'context.expose_paths[] must be an absolute path' });

// A revision for `git diff`: a ref, a commit, or HEAD~n -- never an option.
const gitRevision = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._/~^@{}-]+$/, 'context.expose_diff.base must be a git revision (a branch, tag, commit or HEAD~n)')
  .refine((r) => !r.startsWith('-'), { message: 'context.expose_diff.base must not start with "-"' });

export const contextSchema = z
  .object({
    facts: z.array(trimmed(L.factMax, 'context.facts[]')).max(L.factsMax).default([]),
    proposal: z.string().trim().max(L.proposalMax).nullish(),
    counterpoints: z.array(trimmed(L.counterpointMax, 'context.counterpoints[]')).max(L.counterpointsMax).default([]),
    artifacts: z.array(artifactSchema).max(L.artifactsMax).default([]),
    expose_paths: z.array(exposedPathSchema).max(L.exposePathsMax).default([]),
    // The lead's uncommitted (or since-`base`) change: its diff goes in the
    // brief and the files it touches are copied, under workspace/repo/ at
    // their paths in the repository. The repository's location is not sent.
    expose_diff: z.object({ repo: exposedPathSchema, base: gitRevision.optional() }).strict().nullish(),
    // A follow-up only: copy again, as they are now, the paths the parent
    // round exposed. Never implied -- what reaches another vendor's model is
    // what the lead named in this call.
    expose_from_parent: z.boolean().optional(),
  })
  .strict();

// A consultant, by whatever the lead was told to call it: the operator's name
// for it, its CLI, its vendor, or its model ("glm", "claude opus"). Which
// consultant that is depends on the operator's config, so it is resolved in
// parseRequest, not by an enum here.
const targetSpec = z.string().trim().min(1, 'target must not be empty').max(120, 'target exceeds 120 characters')
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'target must be a single line of printable characters');

// Who asked for a consultation, as the lead reports it.
export const INITIATORS = ['user'];
export const NETWORK_MODES = ['on', 'off'];

export const requestSchema = z
  .object({
    // Exactly one of `target` (one consultant) or `targets` (ask several the
    // same question) is required; parseRequest below enforces the exclusivity,
    // because zod cannot phrase that refusal usefully.
    target: targetSpec.optional(),
    targets: z.array(targetSpec).min(1).max(POLICY.maxConcurrent).optional(),
    // Identifies the host CLI making this request, if it names itself. Purely
    // an annotation input for the same-vendor caveat below: it must never
    // gate permissions, limits, rounds, or which CLI gets launched.
    caller: z.preprocess(normalizeName, z.enum(CALLER_INPUTS)).nullish(),
    // The model the host CLI is running on, if it says. Self-declared like
    // `caller`, unverifiable by the server, and used for one thing: so a
    // same-vendor caveat can say "same lineage, different model" (a Fable
    // lead asking Opus) instead of treating every same-vendor call as the
    // same head. Never gates the model launched, which comes from `target`.
    caller_model: trimmed(120, 'caller_model')
      .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'caller_model must be a single line of printable characters')
      .nullish(),
    // "user" when the user asked for this consultation, as the lead reports
    // it. Self-declared and unverifiable like caller_model, and it never gates
    // anything. "offer_accepted" came from Skills before 1.13.0, which offered
    // a consultation instead of starting one; it is read as not declared
    // rather than refused, so an older Skill's consultation still starts.
    initiator: z.preprocess((v) => (v === 'offer_accepted' ? null : v), z.enum(INITIATORS).nullish()),
    // Optional: what the context holds already decides which mode it can pass
    // (see parseRequest), so a mode left out is read from it. Given, it wins.
    mode: z.enum(MODES).optional(),
    // "off" takes web search and browsing away from every consultant in this
    // round, for a brief that must not leave the machine through a URL. The
    // consultant still reads the brief and the disk; it reaches nothing else.
    network: z.enum(NETWORK_MODES).default('on'),
    question: trimmed(L.questionMax, 'question'),
    // Optional: most consultations state what they are after in the question
    // itself, and a second field that repeats it is friction, not information.
    objective: trimmed(L.objectiveMax, 'objective').nullish(),
    success_criteria: z.array(trimmed(L.constraintMax, 'success_criteria[]')).max(L.constraintsMax).default([]),
    constraints: z.array(trimmed(L.constraintMax, 'constraints[]')).max(L.constraintsMax).default([]),
    // prefault, not default: zod 4 returns a default as is, skipping the inner defaults (expose_paths among them).
    context: contextSchema.prefault({}),
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

export function charCount(req) {
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
export function parseRequest(raw, { isFollowup = false, parentMode = null } = {}) {
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
  const listed = () => availableConsultants().map((c) => `${c.name} (${c.cli}, ${c.model})`).join(', ')
    || 'none -- no consultant CLI is available here';
  if (!hasSingle && !hasMany) {
    throw new RequestError(
      `name the consultant: target: a consultant, its CLI or its model (available: ${listed()}), or targets: [...] to ask several the same question, targets: ["all"] to ask everyone`,
      'target_required',
    );
  }
  const named = hasSingle ? [req.target] : req.targets;
  const isAll = named.map((n) => normalizeName(n) === 'all');
  if (isAll.some(Boolean) && named.length > 1) {
    throw new RequestError('"all" already means every available consultant; pass it alone', 'all_mixed');
  }

  let chosen;
  if (isAll[0]) {
    chosen = availableConsultants();
    if (!chosen.length) {
      throw new RequestError('no consultant is available on this machine -- install one of the CLIs, or check the config file', 'target_unavailable');
    }
  } else {
    // Resolved among the reachable consultants first, so one that is off does
    // not make a name ambiguous; only a name none of them answers to is tried
    // against the rest, so a consultant that is off is refused with its reason
    // instead of looking unknown -- rather than costing a slot and failing
    // minutes later.
    const reachable = availableConsultants();
    chosen = named.map((name) => {
      let r = resolveConsultant(name, reachable, POLICY.ranking);
      if (r.none) r = resolveConsultant(name, POLICY.consultants, POLICY.ranking);
      if (r.none) {
        throw new RequestError(`no consultant answers to ${JSON.stringify(name)}; available: ${listed()}`, 'unknown_target');
      }
      if (r.ambiguous) {
        throw new RequestError(
          `${JSON.stringify(name)} fits more than one consultant and no ranking rule decides between `
          + `${r.ambiguous.map((c) => `${c.name} (${c.cli}, ${c.model})`).join(', ')}; name one of them`,
          'target_ambiguous',
        );
      }
      return r.consultant;
    });
    const off = [...new Set(chosen.filter((c) => !consultantAvailable(c)))];
    if (off.length) {
      throw new RequestError(
        `consultant ${off.map((c) => `${JSON.stringify(c.name)} (${unavailableReason(c)})`).join(', ')} `
        + `is not available on this machine; available: ${listed()}`,
        'target_unavailable',
      );
    }
  }

  const unique = [...new Set(chosen.map((c) => c.name))];
  if (unique.length !== chosen.length) {
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
  req.caller = resolveCaller(req.caller ?? '') ?? null;
  req.caller_model = req.caller_model ?? null;
  req.initiator = req.initiator ?? null;
  req.followup_to = req.followup_to ?? null;
  const proposal = (req.context.proposal ?? '').trim();
  req.context.proposal = proposal.length ? proposal : null;
  // A mode left out: a follow-up keeps its chain's; a first round takes the
  // one its context fits -- no proposal is explore, a proposal is review, a
  // proposal with the other side's claims is debate. Checked below like a
  // mode that was given.
  req.mode ??= parentMode
    ?? (!req.context.proposal ? 'explore' : req.context.counterpoints.length ? 'debate' : 'review');

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
  if (req.context.expose_from_parent && !isFollowup) {
    throw new RequestError(
      'context.expose_from_parent copies what an earlier round exposed, so it needs followup_to; name the files in context.expose_paths on a first round',
      'expose_from_parent_needs_followup',
    );
  }
  if (req.context.facts.length === 0 && req.context.artifacts.length === 0 && req.context.expose_paths.length === 0
    && !req.context.expose_diff && !req.context.expose_from_parent) {
    throw new RequestError(
      'provide at least one entry in context.facts, context.artifacts or context.expose_paths: the consultant starts in an empty working directory and is not told where your repository is, so every fact it needs must be in the request',
      'context_required',
    );
  }
  return req;
}
