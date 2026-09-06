/**
 * CLI entry point: starts the Writer MCP server on stdio.
 * Kept separate from index.ts so importing the package as a library
 * never auto-starts a server, and the bin stub always does.
 */

import { WriterMCPServer } from './server.js';

void new WriterMCPServer().start();
