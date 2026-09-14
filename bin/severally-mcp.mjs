#!/usr/bin/env node
import { main } from '../src/server.mjs';

main().catch((err) => {
  process.stderr.write(`severally: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
