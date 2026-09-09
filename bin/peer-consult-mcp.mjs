#!/usr/bin/env node
import { main } from '../src/server.mjs';

main().catch((err) => {
  process.stderr.write(`peer-consult: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
