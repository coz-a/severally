/// <reference path="./cross-spawn-escape.d.ts" />
import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import spawn from 'cross-spawn';
import escape from 'cross-spawn/lib/util/escape.js';
import parseSpawn from 'cross-spawn/lib/parse.js';
import { ChildProcess, spawn as nativeSpawn, spawnSync as nativeSpawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { windowsJobInvocation } from './windows-job.mjs';

/**
 * @param {string} source
 * @param {string} destination
 */
export function copyTree(source, destination) {
  // Node 22.23.2's native cpSync fast path corrupts non-ASCII Windows paths.
  // A filter selects its JS traversal, preserving Japanese directory names.
  fs.cpSync(source, destination, { recursive: true, filter: () => true });
}

/** @typedef {import('node:child_process').SpawnOptions & { cwd?: string | undefined, env?: NodeJS.ProcessEnv | undefined }} SpawnOpts */

/**
 * @template {SpawnOpts} O
 * @param {string} command
 * @param {readonly string[]} args
 * @param {O} options
 */
function batchInvocation(command, args, options) {
  if (process.platform !== 'win32') return null;
  const resolved = findCommand(command, options);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return null;
  // cross-spawn only double-escapes shims inside node_modules/.bin. Global
  // npm shims (and user wrappers forwarding %*) need the same second pass.
  const forwarding = /%\*/.test(fs.readFileSync(resolved, 'utf8'));
  const line = [escape.command(resolved), ...args.map((arg) => escape.argument(arg, forwarding))].join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { ...options, windowsHide: true, windowsVerbatimArguments: true },
  };
}

/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {SpawnOpts & { stdio: ['pipe', 'pipe', 'pipe'] }} options
 * @returns {import('node:child_process').ChildProcessWithoutNullStreams}
 */
/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {SpawnOpts} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {SpawnOpts} [options]
 */
export function spawnCommand(command, args, options = {}) {
  const batch = batchInvocation(command, args, options);
  return batch ? nativeSpawn(batch.command, batch.args, batch.options) : spawn(command, args, options);
}

/**
 * Processes launched through runChild use a Windows launch Job; direct
 * synchronous probes and taskkill keep the ordinary spawn path. Preserve the existing cmd/shebang preparation.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {SpawnOpts & { stdio: ['pipe', 'pipe', 'pipe'] }} options
 * @returns {import('node:child_process').ChildProcessWithoutNullStreams}
 */
export function spawnManagedCommand(command, args, options) {
  if (process.platform !== 'win32') return spawnCommand(command, args, options);
  const batch = batchInvocation(command, args, options);
  const parsed = batch ?? parseSpawn(command, args, options);
  // cross-spawn may turn an unresolved command into a cmd.exe invocation.
  // Check the requested file too, before accepting that interpreter.
  const executable = findCommand(command, options) ? findCommand(parsed.command, options) : null;
  if (!executable) {
    // Never let another resolver silently launch an unmanaged process.
    // Preserve spawn's asynchronous ENOENT contract without starting a process.
    const failed = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    process.nextTick(() => {
      failed.stdout.end();
      failed.stderr.end();
      failed.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
      failed.emit('close', null, null);
    });
    return /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (failed);
  }
  const managed = windowsJobInvocation(executable, parsed.args, parsed.options);
  return /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (
    nativeSpawn(managed.command, managed.args, managed.options)
  );
}

// Explicit script paths are supported by cross-spawn's shebang handling too.
/**
 * @param {string} command
 * @param {{ cwd?: string | undefined, env?: NodeJS.ProcessEnv | undefined }} [options]
 * @returns {string | null}
 */
export function findCommand(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (typeof command !== 'string' || !command) return null;
  cwd = path.resolve(cwd);
  const windows = process.platform === 'win32';
  const value = (/** @type {string} */ name) => {
    const key = windows ? Object.keys(env).find((k) => k.toUpperCase() === name) : name;
    return key === undefined ? undefined : env[key];
  };
  const explicit = command.includes('/') || (windows && command.includes('\\'));
  const dirs = explicit ? [cwd] : [...(windows ? [cwd] : []), ...(value('PATH') ?? '').split(path.delimiter).filter(Boolean)];
  for (const dir of dirs) {
    // Absolute candidates prevent which's own cwd lookup from resolving a
    // wrapper in the server directory instead of the child's directory.
    const candidate = path.resolve(cwd, dir.replace(/^"(.*)"$/, '$1'), command);
    const found = which.sync(candidate, { nothrow: true, pathExt: value('PATHEXT') });
    if (found) return found;
  }
  if (explicit) {
    const candidate = path.resolve(cwd, command);
    try {
      if (!fs.statSync(candidate).isFile()) return null;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not installed */
    }
  }
  return null;
}

/** @typedef {Omit<import('node:child_process').SpawnSyncOptionsWithStringEncoding, 'cwd' | 'encoding'> & { cwd?: string, encoding?: BufferEncoding }} ExecOptions */

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {ExecOptions} [options]
 * @returns {string}
 */
export function execCommandSync(command, args, options = {}) {
  /** @type {BufferEncoding} */
  const encoding = 'utf8';
  const opts = { windowsHide: true, encoding, ...options };
  const batch = batchInvocation(command, args, opts);
  const result = batch ? nativeSpawnSync(batch.command, batch.args, batch.options) : spawn.sync(command, args, opts);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} exited with ${result.status ?? result.signal}`), result);
  }
  return result.stdout;
}
