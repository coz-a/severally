// The only local plugin placed in an OpenCode consultant's synthetic HOME.
// Keep this dependency-free: OpenCode loads it before any tool executes.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS_CASE_INSENSITIVE, protectedRoots, protectedRootPatterns, protectedNamePatterns } from '../policy.mjs';

/**
 * Serialized into the plugin below, including its runtime path checks.
 * Rewriting to the canonical path avoids a later swap of the original alias.
 * This is not an atomic open: replacement of a canonical ancestor between the
 * hook and the CLI's read remains outside this guard's guarantee.
 * @param {string} tool
 * @param {unknown} args
 * @param {string} workdir
 * @param {{ paths: string[], roots: string[], names: string[], insensitive: boolean }} rules
 * @param {{ fs: typeof import('node:fs'), path: typeof import('node:path') }} io
 */
function checkRead(tool, args, workdir, rules, io) {
  if (tool !== 'read') return;
  const deny = () => {
    throw new Error('severally read denied: protected or unresolvable path');
  };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return deny();
  const values = /** @type {Record<string, unknown>} */ (args);
  // OpenCode 1.x uses filePath; 2.x uses path. Ambiguous or changed shapes
  // fail closed instead of checking a field the CLI might not read.
  const keys = ['path', 'filePath'].filter((key) => Object.hasOwn(values, key));
  const key = keys[0];
  if (keys.length !== 1 || !key) return deny();
  const value = values[key];
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return deny();
  const absolute = io.path.resolve(workdir, value);
  let real;
  try {
    real = io.fs.realpathSync.native(absolute);
  } catch {
    return deny();
  }
  const flags = rules.insensitive ? 'i' : '';
  // A configured credential root can be created or retargeted after launch.
  // Keep the original deny patterns AND resolve its current target each time.
  const currentRoots = rules.paths.flatMap((root) => {
    try {
      const resolved = io.fs.realpathSync.native(root).replaceAll('\\', '/').replace(/\/+$/, '');
      return [rules.insensitive ? resolved.toLowerCase() : resolved];
    } catch {
      // Missing roots and wildcard legacy-home paths retain the original rules.
      return [];
    }
  });
  for (const candidate of [absolute, real]) {
    const fwd = candidate.replaceAll('\\', '/');
    const normalized = rules.insensitive ? fwd.toLowerCase() : fwd;
    if (
      rules.roots.some((p) => new RegExp(p, flags).test(fwd)) ||
      currentRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`)) ||
      rules.names.some((p) => new RegExp(p, flags).test(io.path.basename(fwd)))
    )
      return deny();
  }
  values[key] = real;
}

/** @param {string} configDir @param {string} workdir */
export function writeReadGuard(configDir, workdir) {
  const pluginDir = path.join(configDir, 'plugins');
  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  const rules = {
    paths: protectedRoots(),
    roots: protectedRootPatterns(),
    names: protectedNamePatterns(),
    insensitive: PATHS_CASE_INSENSITIVE,
  };
  fs.writeFileSync(
    path.join(pluginDir, 'severally-read-guard.js'),
    `import fs from 'node:fs';
import path from 'node:path';
const workdir = ${JSON.stringify(path.resolve(workdir))};
const rules = ${JSON.stringify(rules)};
const checkRead = ${checkRead.toString()};
export default {
  id: 'severally-read-guard',
  async setup(ctx) {
    await ctx.tool.hook('execute.before', (event) => checkRead(event.tool, event.input, workdir, rules, { fs, path }));
  },
  async server() {
    return { 'tool.execute.before': async (input, output) => checkRead(input.tool, output.args, workdir, rules, { fs, path }) };
  },
};
`,
    { mode: 0o600 },
  );
}
