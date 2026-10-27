// S3 preflight and post-start material verification. No model is called here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { POLICY } from '../src/policy.mjs';

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
/** @param {string} repo @param {string[]} args */
function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('S3 repository or tracked material could not be verified with git');
  }
}

/**
 * Validate the fixed repository and explicitly selected files before a model starts.
 * @param {any} manifest
 */
export function prepareS3Material(manifest) {
  const material = manifest?.material;
  if (!material || typeof material.repo !== 'string' || !path.isAbsolute(material.repo))
    throw new Error('S3 material.repo must be an absolute repository path');
  const repo = fs.realpathSync.native(material.repo);
  if (fs.realpathSync.native(git(repo, ['rev-parse', '--show-toplevel'])) !== repo)
    throw new Error('S3 material.repo must name the repository root');
  if (typeof material.commit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(material.commit))
    throw new Error('S3 material.commit must be a full commit ID');
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (head.toLowerCase() !== material.commit.toLowerCase()) throw new Error('S3 repository HEAD changed');
  if (git(repo, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('S3 repository must be clean, including untracked files');
  if (!Array.isArray(material.files) || !material.files.length || material.files.length > POLICY.input.exposeFilesMax)
    throw new Error('S3 material.files must name a bounded, non-empty set of files');
  /** @type {{path: string, source: string, bytes: number, sha256: string, copy_sha256: string}[]} */
  const files = [];
  let total = 0;
  for (const file of material.files) {
    if (
      typeof file?.path !== 'string' ||
      !file.path ||
      path.isAbsolute(file.path) ||
      file.path.includes('\\') ||
      file.path.split('/').some((/** @type {string} */ part) => !part || part === '.' || part === '..') ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
    )
      throw new Error('S3 material file path must be a safe relative path with a SHA-256');
    const source = path.resolve(repo, ...file.path.split('/'));
    const relative = path.relative(repo, source);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('S3 material path is outside the repository');
    if (files.some((entry) => entry.source === source)) throw new Error('S3 material files must not repeat');
    git(repo, ['ls-files', '--error-unmatch', '--', `:(literal)${file.path}`]);
    if (!fs.lstatSync(source).isFile() || fs.realpathSync.native(source) !== source)
      throw new Error('S3 material cannot include symlinks or non-files');
    const size = fs.statSync(source).size;
    total += size;
    if (total > POLICY.input.exposeBytesMax) throw new Error('S3 material exceeds the exposure size limit');
    const contents = fs.readFileSync(source);
    if (sha256(contents) !== file.sha256.toLowerCase()) throw new Error('S3 material hash changed');
    let headBytes;
    try {
      headBytes = execFileSync('git', ['-C', repo, 'cat-file', 'blob', `${head}:${file.path}`], {
        maxBuffer: POLICY.input.exposeBytesMax + 1,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('S3 material is not a readable tracked HEAD blob');
    }
    // Compare raw bytes, not a filtered worktree hash: line-ending conversion
    // or a clean filter makes the relationship ambiguous, so reject the trial.
    if (!contents.equals(headBytes)) throw new Error('S3 material bytes differ from HEAD; check line endings and filters');
    files.push({
      path: file.path,
      source,
      bytes: size,
      sha256: file.sha256.toLowerCase(),
      copy_sha256: sha256(Buffer.concat([Buffer.from('\0'), contents])),
    });
  }
  const context = manifest.request?.context;
  if (
    !Array.isArray(context?.expose_paths) ||
    context.expose_paths.length !== files.length ||
    context.expose_paths.some((/** @type {unknown} */ p, /** @type {number} */ i) => p !== files[i]?.source) ||
    context.expose_diff ||
    context.expose_from_parent ||
    manifest.request?.followup_to ||
    manifest.request?.retry_of
  )
    throw new Error('S3 request expose_paths must exactly match the fixed material files in order');
  return { repo, commit: head, files, total_bytes: total };
}

/**
 * Compare what consult_start says it copied with the fixed original bytes.
 * A redaction, missing file or unexpected material is not a verified S3 trial.
 * @param {ReturnType<typeof prepareS3Material>} prepared
 * @param {any} start
 */
export function verifyS3Material(prepared, start) {
  const copied = start?.exposed_material;
  if (
    !copied ||
    !Array.isArray(copied.entries) ||
    copied.entries.length !== prepared.files.length ||
    copied.totals?.files !== prepared.files.length ||
    copied.totals?.bytes !== prepared.total_bytes ||
    copied.skipped?.length ||
    copied.skipped_omitted
  )
    throw new Error('S3 copied material does not match the fixed material');
  for (const [i, expected] of prepared.files.entries()) {
    const entry = copied.entries[i];
    if (
      entry?.source !== expected.source ||
      entry.kind !== 'file' ||
      entry.files !== 1 ||
      entry.bytes !== expected.bytes ||
      entry.sha256 !== expected.copy_sha256
    )
      throw new Error('S3 copied material does not match the fixed material');
  }
  return {
    verified: true,
    commit: prepared.commit,
    files: prepared.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
}
