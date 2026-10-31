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
//   materializeExposedPaths  the real copy, once per request into the
//                        group's directory; each consultant job then gets its
//                        own copy of that one snapshot, so every member of a
//                        fan-out reads the same bytes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { POLICY, isProtectedPath } from './policy.mjs';
import { redact, redactWithReport } from './redact.mjs';

/** @typedef {{ files: number, bytes: number }} ExposeTotals */

/**
 * A path left out of the copy, with why: 'ignored', 'symlink', 'hardlink', 'protected',
 * 'submodule', 'gone', 'masked' or 'replaced'. `exposed_as` names it where a
 * follow-up carries over an earlier round's entry.
 * @typedef {{ source: string, reason: string, exposed_as?: string | undefined }} SkippedPath
 */

/**
 * One exposed entry as the walk and the copy report it. `kind` is 'file',
 * 'directory', 'diff' or 'change_files'.
 * @typedef {object} ExposeEntry
 * @property {number} index
 * @property {string} source
 * @property {string} kind
 * @property {string} exposedAs
 * @property {number} files
 * @property {number} bytes
 * @property {string[]} paths
 * @property {string | null} [sha256]
 * @property {string | undefined} [base]
 * @property {string[]} [changes]
 * @property {boolean} [changed] a follow-up's copy of a parent path: whether its bytes changed since
 * @property {boolean} [inherited] a follow-up copied it again from the parent round
 */

/**
 * What an expose_paths request comes to: the entries, their totals, and what was left out.
 * @typedef {{ entries: ExposeEntry[], totals: ExposeTotals, skipped: SkippedPath[], redacted?: boolean }} ExposeManifest
 */

/** A path as the lead names it, or as an earlier round numbered it. @typedef {string | { source: string, index: number }} ExposePathSpec */

/**
 * An entry of an earlier round's brief record (briefRecord's `expose_paths.entries`).
 * @typedef {object} ExposedEntryRecord
 * @property {number} index
 * @property {string} source
 * @property {string | undefined} [exposed_as]
 * @property {string | undefined} [kind]
 * @property {string | undefined} [base]
 * @property {string[] | undefined} [changes]
 */

/** @typedef {{ path: string, status: string }} RepoChange */

export class ExposeError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {unknown[] | undefined} [details]
   */
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'ExposeError';
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {string} source
 * @param {Map<string, boolean>} [cache]
 */
function hasProtectedAncestor(source, cache = new Map()) {
  let current = path.resolve(source);
  /** @type {string[]} */
  const checked = [];
  for (;;) {
    const cached = cache.get(current);
    if (cached !== undefined) {
      for (const p of checked) cache.set(p, cached);
      return cached;
    }
    checked.push(current);
    if (isProtectedPath(current)) {
      for (const p of checked) cache.set(p, true);
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      for (const p of checked) cache.set(p, false);
      return false;
    }
    current = parent;
  }
}

/**
 * A size a reader can judge at a glance; the brief is read, not parsed.
 * @param {number} bytes
 */
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
/** @param {Uint8Array} buf */
function isBinary(buf) {
  const len = Math.min(buf.length, 8_000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// Before a file is read: the caps are a few megabytes, and a 1 GB file must
// be refused by its size, not after it has been read into memory and written.
/**
 * @param {ExposeTotals} totals
 * @param {number} size
 * @param {string} source
 */
function ensureRoom(totals, size, source) {
  const observed = { files: totals.files + 1, bytes: totals.bytes + size };
  try {
    checkBudget(observed);
  } catch (err) {
    if (err instanceof ExposeError && err.code === 'too_large') {
      err.details = [
        {
          kind: 'exposure_limit',
          partial: true,
          observed,
          limits: { files: POLICY.input.exposeFilesMax, bytes: POLICY.input.exposeBytesMax },
          crossing: { source: redact(source).slice(0, 1000), bytes: size },
        },
      ];
    }
    throw err;
  }
}

/** @param {ExposeTotals} totals */
function checkBudget(totals) {
  if (totals.files > POLICY.input.exposeFilesMax) {
    throw new ExposeError(
      `expose_paths reaches more than ${POLICY.input.exposeFilesMax} files, over the file cap; name the files or ` +
        'the subdirectory that actually matters instead of the tree above them',
      'too_large',
    );
  }
  if (totals.bytes > POLICY.input.exposeBytesMax) {
    throw new ExposeError(
      `expose_paths reaches more than ${humanSize(POLICY.input.exposeBytesMax)}, over the size cap; name the files ` +
        'or the subdirectory that actually matters instead of the tree above them',
      'too_large',
    );
  }
}

// A path the lead named, as opposed to one found while walking: it is refused
// rather than skipped, because a lead who typed a symlink meant something by
// it and should hear which entry could not be used.
/** @param {string} source */
function statEntry(source) {
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch (err) {
    throw new ExposeError(`expose_paths entry "${source}" cannot be read: ${messageOf(err)}`, 'not_found');
  }
  if (stat.isSymbolicLink()) {
    throw new ExposeError(`expose_paths entry "${source}" is a symlink; name the path it points at instead`, 'invalid_type');
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new ExposeError(`expose_paths entry "${source}" is neither a file nor a directory`, 'invalid_type');
  }
  if (stat.isFile() && stat.nlink > 1) {
    throw new ExposeError(
      `expose_paths entry "${source}" has multiple hard links; provide an independent copy instead`,
      'invalid_type',
    );
  }
  return stat;
}

// Depth-first over one entry. `onFile(absolutePath, pathRelativeToTheEntry)`
// accounts for the file (it owns the totals), and the budget is checked after
// every single one, so an oversized tree stops at the file that crossed the
// line rather than after the whole thing has been walked or copied.
/**
 * @param {string} root
 * @param {string} dir
 * @param {(abs: string, rel: string) => void} onFile
 * @param {ExposeTotals} totals
 * @param {SkippedPath[]} skipped
 */
function walkDir(root, dir, onFile, totals, skipped) {
  let items;
  try {
    // In name order, so the same tree hashes the same however its directory
    // entries were created.
    items = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (err) {
    throw new ExposeError(`expose_paths entry "${dir}" cannot be read: ${messageOf(err)}`, 'not_found');
  }
  for (const item of items) {
    const child = path.join(dir, item.name);
    // Outside git there is no .gitignore to say what is not source: these two
    // are never what a consultant should read, and would hit the caps alone.
    if (item.name === '.git' || item.name === 'node_modules') {
      skipped.push({ source: child, reason: 'ignored' });
      continue;
    }
    // Not followed: a link inside a directory the lead exposed can resolve
    // anywhere on the disk, which is exactly the scope this feature exists
    // to keep drawn. Recorded rather than dropped silently, so a consultant
    // reading a thin tree can be told why it is thin.
    if (item.isSymbolicLink()) {
      skipped.push({ source: child, reason: 'symlink' });
      continue;
    }
    // Credentials and history are refused to the consultant's own reads;
    // copying them into its workspace would hand them over anyway.
    if (isProtectedPath(child)) {
      skipped.push({ source: child, reason: 'protected' });
      continue;
    }
    if (item.isDirectory()) {
      walkDir(root, child, onFile, totals, skipped);
    } else if (item.isFile()) {
      if (fs.lstatSync(child).nlink > 1) {
        skipped.push({ source: child, reason: 'hardlink' });
        continue;
      }
      onFile(child, path.relative(root, child));
      checkBudget(totals);
    }
    // Sockets, FIFOs and devices are neither: nothing a consultant can
    // usefully read, and nothing whose size means anything.
  }
}

// walkDir's order: name by name at every level, not the whole path as one
// string ("a/x" comes before "a-b" there, after it as a string).
/**
 * @param {string} a
 * @param {string} b
 */
function byPathParts(a, b) {
  const x = a.split('/');
  const y = b.split('/');
  for (const [i, part] of x.entries()) {
    const other = y[i];
    if (other === undefined) break;
    if (part !== other) return part < other ? -1 : 1;
  }
  return x.length - y.length;
}

// A directory inside a git work tree: the candidates are what git lists
// (tracked, plus untracked that .gitignore does not exclude), so `.git` and
// ignored trees drop out. Every candidate gets walkDir's checks again -- a
// committed .env is still protected, a listed file may be gone, a link, a
// submodule, or reach outside the directory. False when this is not a work
// tree, git is missing or lists nothing (an ignored directory the lead named
// on purpose): the caller walks it instead.
/**
 * @param {string} dir
 * @param {string} exposedAs
 * @param {(abs: string, rel: string) => void} onFile
 * @param {ExposeTotals} totals
 * @param {SkippedPath[]} skipped
 * @returns {boolean}
 */
function walkGit(dir, exposedAs, onFile, totals, skipped) {
  let listed;
  let ignored;
  try {
    listed = [...new Set(nulSplit(git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])))];
    ignored = nulSplit(git(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']));
  } catch {
    return false;
  }
  if (listed.length === 0) return false;
  for (const p of ignored) skipped.push({ source: path.join(dir, p), reason: 'ignored' });
  if (fs.existsSync(path.join(dir, '.git'))) skipped.push({ source: path.join(dir, '.git'), reason: 'ignored' });
  const realDir = fs.realpathSync(dir);
  const protectedDirs = new Set();
  for (const rel of listed.sort(byPathParts)) {
    const abs = path.join(dir, rel);
    // walkDir never enters a protected directory (.env.d/, .ssh/ ...); a
    // listed file is checked with each directory above it for the same reason.
    const parts = rel.split('/');
    const guarded = parts
      .slice(0, -1)
      .map((_, i) => path.join(dir, ...parts.slice(0, i + 1)))
      .find(isProtectedPath);
    if (guarded) {
      if (!protectedDirs.has(guarded)) skipped.push({ source: guarded, reason: 'protected' });
      protectedDirs.add(guarded);
      continue;
    }
    if (isProtectedPath(abs)) {
      skipped.push({ source: abs, reason: 'protected' });
      continue;
    }
    let stat;
    // Deleted in the work tree but still in the index: not part of the tree
    // as it is now, so not part of the copy either.
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    // A directory here is a submodule (or a nested repository): its own history, not this one's files.
    if (stat.isDirectory()) {
      skipped.push({ source: abs, reason: 'submodule' });
      continue;
    }
    const inside = (() => {
      try {
        return fs.realpathSync(abs).startsWith(realDir + path.sep);
      } catch {
        return false;
      }
    })();
    if (stat.isSymbolicLink() || !inside) {
      skipped.push({ source: abs, reason: 'symlink' });
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.nlink > 1) {
      skipped.push({ source: abs, reason: 'hardlink' });
      continue;
    }
    onFile(abs, path.normalize(rel));
    checkBudget(totals);
  }
  return true;
}

// Each path is a string, or { source, index } to keep the name an earlier
// round gave it.
/**
 * @param {ExposePathSpec[]} exposePaths
 * @param {(abs: string, rel: string, index: number, source: string, totals: ExposeTotals, expected: string) => void} onFile
 * @returns {ExposeManifest}
 */
function walkEntries(exposePaths, onFile) {
  const totals = { files: 0, bytes: 0 };
  /** @type {SkippedPath[]} */
  const skipped = [];
  const entries = exposePaths.map((p, i) => {
    const { source, index } = typeof p === 'string' ? { source: p, index: i } : p;
    let realSource;
    try {
      realSource = fs.realpathSync.native(source);
    } catch (err) {
      throw new ExposeError(`expose_paths entry "${source}" cannot be resolved: ${messageOf(err)}`, 'not_found');
    }
    const stat = statEntry(source);
    // Indexed, so two entries whose basenames collide (two different
    // util.mjs) stay apart, and the brief can name each one exactly.
    const exposedAs = `workspace/${index}-${path.basename(source)}`;
    const before = { files: totals.files, bytes: totals.bytes };
    // What a directory holds, for the brief: not every consultant has a tool
    // that lists a directory, and a name it cannot see is a file it never reads.
    /** @type {string[]} */
    const paths = [];
    if (hasProtectedAncestor(source)) {
      skipped.push({ source, reason: 'protected' });
    } else if (stat.isFile()) {
      onFile(source, '', index, source, totals, realSource);
      checkBudget(totals);
    } else {
      /** @type {(abs: string, rel: string) => void} */
      const add = (abs, rel) => {
        paths.push(rel.split(path.sep).join('/'));
        onFile(abs, rel, index, source, totals, path.join(realSource, rel));
      };
      walkGit(source, exposedAs, add, totals, skipped) || walkDir(source, source, add, totals, skipped);
    }
    return {
      index,
      source,
      kind: stat.isDirectory() ? 'directory' : 'file',
      exposedAs,
      files: totals.files - before.files,
      bytes: totals.bytes - before.bytes,
      paths: paths.sort(),
    };
  });
  return { entries, totals, skipped };
}

/**
 * Sizes and counts for the brief, and the caps enforced, without reading a
 * byte of content or writing anything. Sizes are the raw source sizes: the
 * real copy may write slightly fewer bytes once a text file's
 * credential-shaped strings are masked, which only ever shrinks what was
 * already reported.
 * @param {ExposePathSpec[] | null | undefined} exposePaths
 * @returns {ExposeManifest | null}
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
 * @param {string} workdir
 * @param {ExposePathSpec[] | null | undefined} exposePaths
 * @returns {ExposeManifest | null}
 */
export function materializeExposedPaths(workdir, exposePaths) {
  if (!exposePaths || exposePaths.length === 0) return null;
  const root = path.join(workdir, 'workspace');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  /** @type {import('node:crypto').Hash[]} */
  const hashes = [];
  let redacted = false;
  const manifest = walkEntries(exposePaths, (abs, rel, index, source, totals, expected) => {
    ensureRoom(totals, fs.statSync(abs).size, abs);
    const base = path.join(root, `${index}-${path.basename(source)}`);
    const copy = copyMasked(abs, rel ? path.join(base, rel) : base, expected);
    const out = copy.bytes;
    redacted ||= copy.redacted;
    (hashes[index] ??= crypto.createHash('sha256')).update(`${rel}\0`).update(out);
    totals.files += 1;
    totals.bytes += out.length;
  });
  for (const e of manifest.entries) e.sha256 = hashes[e.index]?.digest('hex') ?? null;
  manifest.redacted = redacted;
  return manifest;
}

// The bytes a consultant gets for one file, written to dest: valid-utf8 text
// through redact(), anything else unchanged.
/**
 * @param {string} abs
 * @param {string} dest
 * @param {string} expected Canonical path selected before walking the source.
 */
function copyMasked(abs, dest, expected) {
  const sameLocation = () => path.relative(expected, fs.realpathSync.native(abs)) === '';
  const before = fs.lstatSync(abs);
  if (!before.isFile() || before.nlink > 1 || isProtectedPath(abs))
    throw new ExposeError(`expose_paths entry "${abs}" changed before copying`, 'invalid_type');
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let buf;
  try {
    const stat = fs.fstatSync(fd);
    // Node 22 on Windows reports dev=0 for path stats but a volume serial for
    // descriptor stats. Zero is unavailable, not a different volume. Compare
    // inode identity in both cases and device identity when both report it.
    const sameFile = (/** @type {fs.Stats} */ a, /** @type {fs.Stats} */ b) =>
      a.ino === b.ino && (!a.dev || !b.dev || a.dev === b.dev);
    if (
      !stat.isFile() ||
      stat.nlink > 1 ||
      !sameFile(stat, before) ||
      stat.size !== before.size ||
      stat.mtimeMs !== before.mtimeMs ||
      stat.ctimeMs !== before.ctimeMs ||
      !sameLocation()
    ) {
      throw new ExposeError(`expose_paths entry "${abs}" is no longer a single-link file`, 'invalid_type');
    }
    buf = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(abs);
    if (
      after.nlink > 1 ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      current.isSymbolicLink() ||
      !sameFile(current, stat) ||
      isProtectedPath(abs) ||
      !sameLocation()
    ) {
      throw new ExposeError(`expose_paths entry "${abs}" changed during copying`, 'invalid_type');
    }
  } finally {
    fs.closeSync(fd);
  }
  let out = buf;
  let redacted = false;
  if (!isBinary(buf)) {
    const text = buf.toString('utf8');
    // A lossy round-trip (lone continuation bytes, Shift-JIS, Latin-1, ...)
    // means the original was never valid utf8 text, so redact()'s decode
    // would silently replace bytes with U+FFFD and corrupt the file --
    // treat it like binary and copy it through instead.
    if (Buffer.from(text, 'utf8').equals(buf)) {
      const observed = redactWithReport(text);
      out = Buffer.from(observed.value, 'utf8');
      redacted = observed.redacted;
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, out, { mode: 0o600 });
  return { bytes: out, redacted };
}

// The files of a change, copied under <workdir>/workspace/repo/ at their
// repository paths, credential-masked, into `manifest`'s totals. `shown` hears
// every change the brief should list (copied, deleted, or a submodule). The
// sha256 covers the copies in path order, so the same files give the same
// hash however they were found. `gone` is where a path that no longer exists
// goes; by default it is dropped, as a change listing a vanished path is.
/**
 * @param {string} workdir
 * @param {string} top
 * @param {RepoChange[]} changes
 * @param {ExposeManifest} manifest
 * @param {(c: RepoChange) => void} shown
 * @param {((c: RepoChange) => void) | null} [gone]
 */
function copyRepoFiles(workdir, top, changes, manifest, shown, gone = null) {
  const root = path.join(workdir, 'workspace', 'repo');
  // Made even when nothing is copied (a change that only deletes): each
  // member's workspace is copied from here.
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realTop = fs.realpathSync(top);
  /** @type {Map<string, boolean>} */
  const protectionCache = new Map();
  /** @type {{ path: string, size: number }[]} */
  const copied = [];
  for (const c of changes) {
    const abs = path.join(top, c.path);
    if (hasProtectedAncestor(abs, protectionCache)) {
      manifest.skipped.push({ source: abs, reason: 'protected' });
      continue;
    }
    if (c.status === 'D') {
      shown(c);
      continue;
    }
    let stat;
    // When `gone` is given, the paths are an earlier round's, and a skipped
    // one carries the name it had there.
    const named = gone ? { exposed_as: `workspace/repo/${c.path}` } : {};
    try {
      stat = fs.lstatSync(abs);
    } catch {
      gone?.(c);
      continue;
    }
    // A directory on the way that is now a link out of the repository.
    const inside = (() => {
      try {
        return fs.realpathSync(abs).startsWith(realTop + path.sep);
      } catch {
        return false;
      }
    })();
    if (stat.isSymbolicLink() || !inside) {
      manifest.skipped.push({ source: abs, reason: 'symlink', ...named });
      continue;
    }
    // A submodule: its commit line stays in the diff, nothing to copy.
    if (!stat.isFile()) {
      shown(c);
      continue;
    }
    if (stat.nlink > 1) {
      manifest.skipped.push({ source: abs, reason: 'hardlink', ...named });
      continue;
    }
    shown(c);
    copied.push({ path: c.path, size: stat.size });
  }
  copied.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = crypto.createHash('sha256');
  for (const c of copied) {
    ensureRoom(manifest.totals, c.size, path.join(top, c.path));
    const copy = copyMasked(path.join(top, c.path), path.join(root, c.path), path.join(realTop, c.path));
    const out = copy.bytes;
    manifest.redacted = Boolean(manifest.redacted || copy.redacted);
    hash.update(`${c.path}\0`).update(out);
    manifest.totals.files += 1;
    manifest.totals.bytes += out.length;
    checkBudget(manifest.totals);
  }
  return { copied: copied.map((c) => c.path), sha256: hash.digest('hex') };
}

/**
 * What a follow-up's `expose_from_parent` copies again: the parent round's
 * exposed entries (its brief record), first and in their order, so a path
 * keeps the name it had, then the lead's own `exposePaths` not among them.
 * An entry is left out, with the reason, when its source no longer exists
 * ('gone') or was credential-masked in the record and so names no real path
 * ('masked'). The parent's diff is not taken again: the files it touched are
 * re-copied as they are now (`diffs`, for reexposeChange), because a diff
 * against a base that has since moved would be a different change.
 * @param {ExposedEntryRecord[]} parentEntries
 * @param {string[]} exposePaths
 */
export function planInheritance(parentEntries, exposePaths) {
  /** @type {{ source: string, index: number }[]} */
  const paths = [];
  /** @type {SkippedPath[]} */
  const skipped = [];
  /** @type {ExposedEntryRecord[]} */
  const diffs = [];
  /** @param {string} p */
  const exists = (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  for (const e of parentEntries) {
    if (String(e.source).includes('[REDACTED')) {
      skipped.push({ source: e.source, reason: 'masked', exposed_as: e.exposed_as });
      continue;
    }
    if (!exists(e.source)) {
      skipped.push({ source: e.source, reason: 'gone', exposed_as: e.exposed_as });
      continue;
    }
    if (e.kind === 'diff' || e.kind === 'change_files') {
      diffs.push(e);
      continue;
    }
    paths.push({ source: e.source, index: e.index });
  }
  // New paths are numbered after every name the earlier round used.
  let next = parentEntries.reduce((n, e) => Math.max(n, e.index + 1), 0);
  for (const p of exposePaths) if (!paths.some((x) => x.source === p)) paths.push({ source: p, index: next++ });
  if (paths.length > POLICY.input.exposePathsMax) {
    throw new ExposeError(
      `expose_from_parent and expose_paths together name ${paths.length} entries, over the cap of ` +
        `${POLICY.input.exposePathsMax}; name fewer new paths`,
      'too_large',
    );
  }
  return { paths, skipped, diffs };
}

/**
 * The files an earlier round's change touched, copied again under
 * workspace/repo/ as they are now, added to `manifest` as a 'change_files'
 * entry. Read from that round's record of the change, not from git.
 * @param {string} workdir
 * @param {ExposedEntryRecord} entry
 * @param {ExposeManifest} manifest
 * @returns {boolean}
 */
export function reexposeChange(workdir, entry, manifest) {
  /** @type {RepoChange[]} */
  const changes = [];
  for (const c of entry.changes ?? []) {
    const m = /^(.*) \(([^()]+)\)$/.exec(c);
    const p = m?.[1] ?? c;
    if (p.includes('[REDACTED')) {
      manifest.skipped.push({ source: path.join(entry.source, p), reason: 'masked', exposed_as: `workspace/repo/${p}` });
      continue;
    }
    // A file the change deleted that is back now is copied as it is.
    const deleted = m?.[2] === 'deleted';
    let back = false;
    if (deleted)
      try {
        fs.lstatSync(path.join(entry.source, p));
        back = true;
      } catch {
        /* still deleted */
      }
    changes.push({ path: p, status: deleted ? (back ? 'restored' : 'D') : (m?.[2] ?? 'M') });
  }
  const before = { ...manifest.totals };
  /** @type {RepoChange[]} */
  const shown = [];
  const { copied, sha256 } = copyRepoFiles(
    workdir,
    entry.source,
    changes,
    manifest,
    (c) => shown.push(c),
    (c) =>
      manifest.skipped.push({ source: path.join(entry.source, c.path), reason: 'gone', exposed_as: `workspace/repo/${c.path}` }),
  );
  // Nothing of the change is left to show: no entry, so a follow-up with
  // nothing else to go on is refused rather than sent with an empty copy.
  if (shown.length === 0) {
    try {
      fs.rmdirSync(path.join(workdir, 'workspace', 'repo'));
    } catch {
      /* holds another entry's files */
    }
    return false;
  }
  manifest.entries.push({
    index: manifest.entries.reduce((n, e) => Math.max(n, e.index + 1), 0),
    source: entry.source,
    kind: 'change_files',
    exposedAs: 'workspace/repo',
    base: entry.base,
    files: manifest.totals.files - before.files,
    bytes: manifest.totals.bytes - before.bytes,
    paths: copied,
    changes: shown.map((c) => `${c.path} (${c.status === 'D' ? 'deleted' : c.status})`).sort(),
    sha256,
  });
  return true;
}

// git runs here, on the lead's repository, so nothing in that repository's
// config may run a program: fsmonitor and external diff/textconv drivers are
// switched off, pathspecs are literal, and no shell is involved.
// ponytail: a clean filter (filter.<driver>.clean in .git/config) still runs
// on `git diff` of the working tree; .git/config is local, not cloned.
/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  // Without the server's own GIT_* (GIT_DIR, GIT_INDEX_FILE ... would point
  // at another repository), and without taking the lead's index lock.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  const r = spawnSync('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=', '-C', cwd, ...args], {
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (r.error || r.status !== 0) {
    const why =
      r.error && 'code' in r.error && r.error.code === 'ENOENT'
        ? 'git is not on PATH'
        : String(r.stderr ?? r.error?.message ?? '').trim();
    throw new ExposeError(`context.expose_diff: git ${args[0]} failed in "${cwd}": ${why}`, 'not_found');
  }
  return r.stdout;
}

/** @param {Buffer} buf */
const nulSplit = (buf) => buf.toString('utf8').split('\0').filter(Boolean);

/**
 * The change in `repo` since `base` (default HEAD), added to `manifest`: the
 * files it touches -- tracked changes and untracked ones -- are copied under
 * <workdir>/workspace/repo/ at their repository paths, so the diff's paths
 * name the copies; deleted files are listed, not copied. Protected paths are
 * left out of the copy and of the diff. Returns the diff text, masked and cut
 * to maxChars, for the brief.
 * @param {string} workdir
 * @param {{ repo: string, base?: string | undefined }} source
 * @param {ExposeManifest} manifest
 * @param {number} maxChars
 * @returns {string}
 */
export function exposeDiff(workdir, { repo, base = 'HEAD' }, manifest, maxChars) {
  const top = git(repo, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  git(top, ['rev-parse', '--verify', `${base}^{commit}`]);
  const tokens = nulSplit(
    git(top, ['diff', '--name-status', '-z', '--no-renames', '--no-relative', '--no-ext-diff', '--no-textconv', base, '--']),
  );
  /** @type {RepoChange[]} */
  const changes = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i];
    const file = tokens[i + 1];
    if (status !== undefined && file !== undefined) changes.push({ status, path: file });
  }
  for (const p of nulSplit(git(top, ['ls-files', '--others', '--exclude-standard', '-z'])))
    changes.push({ status: 'untracked', path: p });

  const before = { ...manifest.totals };
  /** @type {RepoChange[]} */
  const shown = [];
  const { copied, sha256 } = copyRepoFiles(workdir, top, changes, manifest, (c) => shown.push(c));
  if (shown.length === 0) {
    throw new ExposeError(
      `context.expose_diff: no change against ${base} to show` +
        (changes.length ? ' (every changed file is a protected path)' : ''),
      'not_found',
    );
  }
  manifest.entries.push({
    index: manifest.entries.reduce((n, e) => Math.max(n, e.index + 1), 0),
    source: top,
    kind: 'diff',
    exposedAs: 'workspace/repo',
    base,
    files: manifest.totals.files - before.files,
    bytes: manifest.totals.bytes - before.bytes,
    // The copies, as paths a consultant can open; the change itself, with
    // what happened to each path, is listed apart.
    paths: copied,
    changes: shown
      .map((c) => `${c.path} (${c.status === 'untracked' ? 'untracked' : c.status === 'D' ? 'deleted' : c.status})`)
      .sort(),
    sha256,
  });

  // One diff of the whole tree, then only the files shown are kept: no
  // pathspecs, so a change of thousands of files does not overflow the
  // command line. Fixed prefixes and repository-relative paths, whatever
  // diff.* config says (a dstPrefix could carry the repository's location); a
  // submodule as its commit line only (diff.submodule=diff would print files
  // inside it, never checked against the protected paths); a deleted file
  // without its old content.
  const tracked = new Set(shown.filter((c) => c.status !== 'untracked').map((c) => c.path));
  const full = tracked.size
    ? git(top, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-relative',
        '--submodule=short',
        '--irreversible-delete',
        base,
        '--',
      ]).toString('utf8')
    : '';
  // A section whose header names no shown path (a protected one, or one git
  // had to quote) is dropped rather than guessed at.
  const observed = redactWithReport(
    full
      .split(/^(?=diff --git )/m)
      .filter((sec) => {
        const rest = sec.slice('diff --git '.length, sec.indexOf('\n'));
        const p = rest.slice(2, 2 + (rest.length - 1) / 2 - 2);
        return tracked.has(p) && rest === `a/${p} b/${p}`;
      })
      .join(''),
  );
  manifest.redacted = Boolean(manifest.redacted || observed.redacted);
  let text = observed.value;
  if (text.length > maxChars) {
    text =
      maxChars < 500
        ? ''
        : `${text.slice(0, maxChars - 200)}\n... [diff cut by severally: ${text.length} characters in all; every changed file is under workspace/repo/]`;
  }
  return text;
}
