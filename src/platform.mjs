import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import spawn from 'cross-spawn';
import escape from 'cross-spawn/lib/util/escape.js';
import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from 'node:child_process';

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

export function spawnCommand(command, args, options = {}) {
  const batch = batchInvocation(command, args, options);
  return batch ? nativeSpawn(batch.command, batch.args, batch.options) : spawn(command, args, options);
}

// Explicit script paths are supported by cross-spawn's shebang handling too.
export function findCommand(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (typeof command !== 'string' || !command) return null;
  cwd = path.resolve(cwd);
  const windows = process.platform === 'win32';
  const value = (name) => env[windows
    ? Object.keys(env).find((key) => key.toUpperCase() === name) : name];
  const explicit = command.includes('/') || (windows && command.includes('\\'));
  const dirs = explicit ? [cwd] : [
    ...(windows ? [cwd] : []),
    ...(value('PATH') ?? '').split(path.delimiter).filter(Boolean),
  ];
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
    } catch { /* not installed */ }
  }
  return null;
}

export function execCommandSync(command, args, options = {}) {
  const opts = { windowsHide: true, encoding: 'utf8', ...options };
  const batch = batchInvocation(command, args, opts);
  const result = batch ? nativeSpawnSync(batch.command, batch.args, batch.options) : spawn.sync(command, args, opts);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} exited with ${result.status ?? result.signal}`), result);
  }
  return result.stdout;
}
