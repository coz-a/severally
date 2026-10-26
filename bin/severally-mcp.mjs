#!/usr/bin/env node
import fs from 'node:fs';

// Checked before anything else loads, so an older Node says what to do
// instead of failing somewhere inside the server or the installer.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(
    `severally: Node.js 22 or newer is needed (this is ${process.versions.node}); update Node.js and run it again\n`,
  );
  process.exit(1);
}

// The package's `install` command runs the installer. Only the full package has the installer
// beside this file; the bundled server copies (the plugin's dist, the
// installed runtime) say what to run instead of starting a server that waits
// on stdin.
if (process.argv[2] === 'install') {
  const installer = new URL('../scripts/install.mjs', import.meta.url);
  if (!fs.existsSync(installer)) {
    process.stderr.write(
      'severally: this is the installed server, not the installer; use the installer archive from https://github.com/coz-a/severally/releases/latest\n',
    );
    process.exit(1);
  }
  process.argv.splice(2, 1);
  await import(installer.href);
} else if (process.argv[2] === 'status') {
  const { status } = await import('../src/status.mjs');
  process.exitCode = status();
} else {
  const { main } = await import('../src/server.mjs');
  main().catch((err) => {
    process.stderr.write(`severally: fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
