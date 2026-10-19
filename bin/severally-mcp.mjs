#!/usr/bin/env node
import fs from 'node:fs';
import { main } from '../src/server.mjs';

// `npx -y severally-mcp@latest install` runs the installer, so installing and
// updating name the package once. Only the npm package has the installer
// beside this file; the bundled server copies (the plugin's dist, the
// installed runtime) say what to run instead of starting a server that waits
// on stdin.
if (process.argv[2] === 'install') {
  const installer = new URL('../scripts/install.mjs', import.meta.url);
  if (!fs.existsSync(installer)) {
    process.stderr.write('severally: this is the installed server, not the installer; run: npx -y severally-mcp@latest install\n');
    process.exit(1);
  }
  process.argv.splice(2, 1);
  await import(installer.href);
} else {
  main().catch((err) => {
    process.stderr.write(`severally: fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
