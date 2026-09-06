/**
 * End-to-end tests for the Writer MCP server: JSON-RPC protocol handling plus
 * a full DOCX revise/export round trip against a real Writer sidecar with a
 * fake codex CLI. Moved here from the nebula-tools root MCP server tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as readline from 'readline';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

describe('Writer MCP Server', () => {
  let serverProcess: ChildProcess;
  let rl: readline.Interface;
  let responsePromises: Map<number | string, { resolve: (value: any) => void; reject: (error: any) => void }>;
  let requestId = 0;

  function sendRequest(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      responsePromises.set(id, { resolve, reject });

      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      serverProcess.stdin!.write(request + '\n');

      setTimeout(() => {
        if (responsePromises.has(id)) {
          responsePromises.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 10000);
    });
  }

  beforeAll(async () => {
    responsePromises = new Map();

    // Spawn through the published bin entry so the packaged path is what we test.
    // Requires a build first (npm test runs it via pretest).
    serverProcess = spawn('node', ['bin/writer-mcp.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    rl = readline.createInterface({
      input: serverProcess.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        const promise = responsePromises.get(response.id);
        if (promise) {
          responsePromises.delete(response.id);
          if (response.error) {
            promise.reject(response.error);
          } else {
            promise.resolve(response.result);
          }
        }
      } catch {
        // Ignore non-JSON lines (startup banner goes to stderr anyway).
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
    if (rl) {
      rl.close();
    }
  });

  it('responds to initialize', async () => {
    const result = await sendRequest('initialize', {});
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('nebula-writer-mcp');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('lists the nine writer tools', async () => {
    const result = await sendRequest('tools/list', {});
    const names = result.tools.map((tool: any) => tool.name).sort();
    expect(names).toEqual([
      'writer_export_review_docx',
      'writer_get_document',
      'writer_list_inline_suggestions',
      'writer_list_suggestions',
      'writer_open_docx',
      'writer_propose_changes',
      'writer_resolve_inline_suggestion',
      'writer_set_suggestion_status',
      'writer_status',
    ]);
  });

  it('returns an error for unknown tools and missing params', async () => {
    const unknown = await sendRequest('tools/call', { name: 'unknown_tool_xyz', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('Unknown tool');

    const missing = await sendRequest('tools/call', { name: 'writer_open_docx', arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Missing required parameter');
  });

  it('never responds to JSON-RPC notifications', async () => {
    // Send a notification (no id); any reply would be a protocol violation.
    serverProcess.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }) + '\n');
    serverProcess.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The server must still answer the next real request, and only that one.
    const result = await sendRequest('tools/list', {});
    expect(result.tools.length).toBe(9);
    expect(responsePromises.size).toBe(0);
  });

  it('explains how to start the sidecar when it is unreachable', async () => {
    const result = await sendRequest('tools/call', {
      name: 'writer_status',
      arguments: { writer_url: 'http://127.0.0.1:1' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not reachable');
    expect(result.content[0].text).toContain('npm run sidecar');
  });

  it('revises and exports a DOCX through Writer MCP tools', async () => {
    const tempDir = mkdtempSync(join(process.cwd(), '.writer-mcp-smoke-'));
    const fakeCodexPath = join(tempDir, 'fake-codex');
    const sourcePath = join(tempDir, 'source.docx');
    const reviewPath = join(tempDir, 'review.docx');
    const writerPort = 19000 + Math.floor(Math.random() * 1000);
    const writerUrl = `http://127.0.0.1:${writerPort}`;
    let sidecar: ChildProcess | null = null;

    writeFileSync(
      fakeCodexPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ] || [ "$1" = "version" ] || [ "$1" = "-v" ]; then',
        '  printf "%s\\n" "codex-cli mcp-smoke"',
        '  exit 0',
        'fi',
        'cat >/dev/null',
        'printf "%s\\n" \'{"message":"One MCP revision.","suggestions":[{"title":"Tighten via MCP","original":"This is actually very wordy.","replacement":"This is wordy.","rationale":"Removes filler through the Writer MCP path.","confidence":0.91}]}\''
      ].join('\n'),
      'utf8'
    );
    chmodSync(fakeCodexPath, 0o755);

    try {
      sidecar = spawn('npm', ['run', 'sidecar'], {
        cwd: join(process.cwd(), '..'),
        env: {
          ...process.env,
          WRITER_ALLOW_CLI: '1',
          WRITER_CODEX_PATH: fakeCodexPath,
          WRITER_SIDECAR_PORT: String(writerPort)
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForWriterSidecar(writerUrl);

      const fixtureResponse = await fetch(`${writerUrl}/api/docx/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'MCP Writer Smoke',
          html: '<p>This is actually very wordy.</p>'
        }),
      });
      expect(fixtureResponse.ok).toBe(true);
      writeFileSync(sourcePath, Buffer.from(await fixtureResponse.arrayBuffer()));

      const open = mcpText(await sendRequest('tools/call', {
        name: 'writer_open_docx',
        arguments: { path: sourcePath, writer_url: writerUrl },
      }));
      expect(open).toContain('Opened: source.docx');

      const proposed = mcpText(await sendRequest('tools/call', {
        name: 'writer_propose_changes',
        arguments: {
          provider: 'codex',
          mode: 'selection',
          selection_text: 'This is actually very wordy.',
          instruction: 'Make the selected sentence shorter.',
          max_suggestions: 3,
          writer_url: writerUrl,
        },
      }));
      expect(proposed).toContain('Added 1 suggestion');
      expect(proposed).toContain('Tighten via MCP');

      const listed = mcpText(await sendRequest('tools/call', {
        name: 'writer_list_suggestions',
        arguments: { writer_url: writerUrl },
      }));
      expect(listed).toContain('This is wordy.');
      const revisionMatch = /Session revision: (\d+)/.exec(listed);
      expect(revisionMatch).not.toBeNull();
      const revision = Number(revisionMatch![1]);
      const suggestionIdMatch = /id=([^)\s]+)\)/.exec(listed);
      expect(suggestionIdMatch).not.toBeNull();
      const suggestionId = suggestionIdMatch![1];

      // A stale expected_revision must be rejected instead of clobbering state.
      const conflict = await sendRequest('tools/call', {
        name: 'writer_set_suggestion_status',
        arguments: { id: suggestionId, status: 'accepted', expected_revision: revision + 1000, writer_url: writerUrl },
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.content[0].text).toContain('another tab or agent');

      // The matching revision succeeds and reports the new one.
      const accepted = mcpText(await sendRequest('tools/call', {
        name: 'writer_set_suggestion_status',
        arguments: { id: suggestionId, status: 'accepted', expected_revision: revision, writer_url: writerUrl },
      }));
      expect(accepted).toContain('Suggestion status updated');
      expect(accepted).toMatch(/Session revision is now \d+/);

      // Return it to pending so the export below still has a pending suggestion.
      const repending = mcpText(await sendRequest('tools/call', {
        name: 'writer_set_suggestion_status',
        arguments: { id: suggestionId, status: 'pending', writer_url: writerUrl },
      }));
      expect(repending).toContain('Suggestion status updated');

      const exported = mcpText(await sendRequest('tools/call', {
        name: 'writer_export_review_docx',
        arguments: { output_path: reviewPath, writer_url: writerUrl },
      }));
      expect(exported).toContain('Review DOCX written');
      expect(existsSync(reviewPath)).toBe(true);
      expect(statSync(reviewPath).size).toBeGreaterThan(1000);
    } finally {
      if (sidecar) {
        sidecar.kill();
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30000);
});

function mcpText(result: any): string {
  if (result?.isError) {
    throw new Error(result.content?.map((item: any) => item.text).join('\n') || 'MCP tool returned isError');
  }
  return result?.content?.map((item: any) => item.text).join('\n') ?? '';
}

async function waitForWriterSidecar(writerUrl: string): Promise<void> {
  const deadline = Date.now() + 10000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${writerUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Writer sidecar did not become ready at ${writerUrl}: ${lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')}`);
}
