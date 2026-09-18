// The one place severally reads the lead's own files. A consultation is
// brief-only by default: the consultant starts in an empty working directory
// and is never told where the repository is. expose_paths is how a lead opts
// specific paths out of that -- and only those paths, copied in rather than
// pointed at, so what the consultant can reach is decided here and not by
// what it guesses.
//
// Two passes, one walker:
//   previewExposePaths   stat only, once per request, before a job exists:
//                        the brief needs the sizes, and a missing path or an
//                        oversized tree is the lead's to fix before a round
//                        of the chain is spent on it.
//   materializeExposedPaths  the real copy, once per consultant job into its
//                        own workdir -- consultants run concurrently and
//                        their job directories are cleaned up independently,
//                        so one shared tree would be deleted underneath a
//                        consultant still reading it.

import fs from 'node:fs';
import path from 'node:path';
import { POLICY } from './policy.mjs';
import { redact } from './redact.mjs';

export class ExposeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExposeError';
    this.code = code;
  }
}

/** A size a reader can judge at a glance; the brief is read, not parsed. */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// A null byte in the first 8KB: the same cheap test every diff tool uses.
// Getting it wrong is survivable in one direction only -- a binary treated as
// text would be corrupted by redact()'s utf8 round-trip, so the test errs
// toward calling things binary.
function isBinary(buf) {
  const len = Math.min(buf.length, 8_000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function checkBudget(totals) {
  if (totals.files > POLICY.input.exposeFilesMax) {
    throw new ExposeError(
      `expose_paths reaches more than ${POLICY.input.exposeFilesMax} files, over the file cap; name the files or `
      + 'the subdirectory that actually matters instead of the tree above them',
      'too_large',
    );
  }
  if (totals.bytes > POLICY.input.exposeBytesMax) {
    throw new ExposeError(
      `expose_paths reaches more than ${humanSize(POLICY.input.exposeBytesMax)}, over the size cap; name the files `
      + 'or the subdirectory that actually matters instead of the tree above them',
      'too_large',
    );
  }
}

// A path the lead named, as opposed to one found while walking: it is refused
// rather than skipped, because a lead who typed a symlink meant something by
// it and should hear which entry could not be used.
function statEntry(source) {
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch (err) {
    throw new ExposeError(`expose_paths entry "${source}" cannot be read: ${err.message}`, 'not_found');
  }
  if (stat.isSymbolicLink()) {
    throw new ExposeError(`expose_paths entry "${source}" is a symlink; name the path it points at instead`, 'invalid_type');
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new ExposeError(`expose_paths entry "${source}" is neither a file nor a directory`, 'invalid_type');
  }
  return stat;
}

// Depth-first over one entry. `onFile(absolutePath, pathRelativeToTheEntry)`
// accounts for the file (it owns the totals), and the budget is checked after
// every single one, so an oversized tree stops at the file that crossed the
// line rather than after the whole thing has been walked or copied.
function walkDir(root, dir, onFile, totals, skipped) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new ExposeError(`expose_paths entry "${dir}" cannot be read: ${err.message}`, 'not_found');
  }
  for (const item of items) {
    const child = path.join(dir, item.name);
    // Not followed: a link inside a directory the lead exposed can resolve
    // anywhere on the disk, which is exactly the scope this feature exists
    // to keep drawn. Recorded rather than dropped silently, so a consultant
    // reading a thin tree can be told why it is thin.
    if (item.isSymbolicLink()) {
      skipped.push(child);
      continue;
    }
    if (item.isDirectory()) {
      walkDir(root, child, onFile, totals, skipped);
    } else if (item.isFile()) {
      onFile(child, path.relative(root, child));
      checkBudget(totals);
    }
    // Sockets, FIFOs and devices are neither: nothing a consultant can
    // usefully read, and nothing whose size means anything.
  }
}

function walkEntries(exposePaths, onFile) {
  const totals = { files: 0, bytes: 0 };
  const skipped = [];
  const entries = exposePaths.map((source, index) => {
    const stat = statEntry(source);
    const before = { files: totals.files, bytes: totals.bytes };
    if (stat.isFile()) {
      onFile(source, '', index, source, totals);
      checkBudget(totals);
    } else {
      walkDir(source, source, (abs, rel) => onFile(abs, rel, index, source, totals), totals, skipped);
    }
    return {
      index,
      source,
      kind: stat.isDirectory() ? 'directory' : 'file',
      // Indexed, so two entries whose basenames collide (two different
      // util.mjs) stay apart, and the brief can name each one exactly.
      exposedAs: `workspace/${index}-${path.basename(source)}`,
      files: totals.files - before.files,
      bytes: totals.bytes - before.bytes,
    };
  });
  return { entries, totals, skipped: skipped.map((source) => ({ source, reason: 'symlink' })) };
}

/**
 * Sizes and counts for the brief, and the caps enforced, without reading a
 * byte of content or writing anything. Sizes are the raw source sizes: the
 * real copy may write slightly fewer bytes once a text file's
 * credential-shaped strings are masked, which only ever shrinks what was
 * already reported.
 */
export function previewExposePaths(exposePaths) {
  if (!exposePaths || exposePaths.length === 0) return null;
  return walkEntries(exposePaths, (abs, _rel, _index, _source, totals) => {
    totals.files += 1;
    totals.bytes += fs.statSync(abs).size;
  });
}

/**
 * The copy the consultant actually reads, under
 * `<workdir>/workspace/<index>-<basename>/`. Valid-utf8 text goes through the
 * same redact() the brief does; binary files, and text in any other encoding,
 * are copied unchanged, since a utf8 round-trip would corrupt them. Walks
 * from scratch and re-checks the caps, so a tree that grew or vanished since
 * the preview fails here instead of being copied in part.
 */
export function materializeExposedPaths(workdir, exposePaths) {
  if (!exposePaths || exposePaths.length === 0) return null;
  const root = path.join(workdir, 'workspace');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return walkEntries(exposePaths, (abs, rel, index, source, totals) => {
    const base = path.join(root, `${index}-${path.basename(source)}`);
    const dest = rel ? path.join(base, rel) : base;
    const buf = fs.readFileSync(abs);
    let out = buf;
    if (!isBinary(buf)) {
      const text = buf.toString('utf8');
      // A lossy round-trip (lone continuation bytes, Shift-JIS, Latin-1, ...)
      // means the original was never valid utf8 text, so redact()'s decode
      // would silently replace bytes with U+FFFD and corrupt the file --
      // treat it like binary and copy it through instead.
      if (Buffer.from(text, 'utf8').equals(buf)) out = Buffer.from(redact(text), 'utf8');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, out, { mode: 0o600 });
    totals.files += 1;
    totals.bytes += out.length;
  });
}
