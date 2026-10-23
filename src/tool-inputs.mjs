import { redact } from './redact.mjs';

// What a consultant ran or opened, as its CLI reported it: shown beside the
// answer so the lead can see where an answer looked. Nothing here says a file
// was read or understood, only that a name appeared in a tool call.
export const MAX_ENTRIES = 30;
export const MAX_CHARS = 200;

/**
 * @typedef {object} ToolInputs
 * @property {string[]} entries the distinct commands or paths, secrets masked, each cut to MAX_CHARS
 * @property {number} omitted how many distinct inputs were left out of `entries`
 * @property {number} exposed_files how many files the consultant was handed
 * @property {number} exposed_mentioned how many of them a tool input names
 */

/**
 * @param {string[]} inputs every input the CLI reported, in order
 * @param {string[]} exposedFiles the handed-over files, relative to ./workspace
 * @returns {ToolInputs}
 */
export function summarizeToolInputs(inputs, exposedFiles = []) {
  const distinct = [...new Set(inputs)];
  // Masked before cut: a key cut in half would no longer match the pattern.
  const entries = distinct.slice(0, MAX_ENTRIES).map((i) => {
    const t = redact(i);
    return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}…` : t;
  });
  // ponytail: a plain substring match on the exposed name, so a command that
  // reaches a file through `cd` or a variable is not counted; this shows where
  // the consultant looked, it does not prove what it did not.
  const exposed_mentioned = exposedFiles.filter((f) => distinct.some((i) => i.includes(f))).length;
  return { entries, omitted: distinct.length - entries.length, exposed_files: exposedFiles.length, exposed_mentioned };
}
