#!/usr/bin/env node
import('../dist/cli.js').catch((error) => {
  console.error('writer-mcp: build output missing — run `npm run build` first.', error.message);
  process.exit(1);
});
