/**
 * Nebula Writer MCP Server
 *
 * Standalone Model Context Protocol server (JSON-RPC 2.0 over stdio) exposing
 * the Writer sidecar tools to coding agents. No notebook server connection is
 * required — every tool talks HTTP to the local Writer sidecar.
 */

import * as readline from 'readline';
import { writerTools } from './writerTools.js';
import type { MCPContent, Tool, ToolDefinition } from './types.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const toolsByName: Map<string, Tool<any, any>> = new Map(
  writerTools.map((tool) => [tool.definition.name, tool])
);

export function getToolDefinitions(): ToolDefinition[] {
  return writerTools.map((tool) => tool.definition);
}

export async function executeToolForMCP(
  name: string,
  params: Record<string, unknown>
): Promise<{ content: MCPContent; isError?: boolean }> {
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const schema = tool.definition.inputSchema;
  if (schema.required) {
    const missing = schema.required.filter((key) => params[key] === undefined || params[key] === null);
    if (missing.length > 0) {
      return {
        content: [{ type: 'text', text: `Error: Missing required parameter(s): ${missing.join(', ')}` }],
        isError: true,
      };
    }
  }
  const knownParams = new Set(Object.keys(schema.properties || {}));
  const unknownParams = Object.keys(params).filter((key) => !knownParams.has(key));
  if (unknownParams.length > 0) {
    return {
      content: [{ type: 'text', text: `Error: Unknown parameter(s): ${unknownParams.join(', ')}. Valid parameters: ${[...knownParams].join(', ')}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.execute(params);
    let content: MCPContent;
    if (tool.formatForMCP) {
      content = await tool.formatForMCP(result);
    } else if (!result.success) {
      content = [{ type: 'text', text: `Error: ${result.error}` }];
    } else {
      content = [{ type: 'text', text: JSON.stringify(result.data, null, 2) }];
    }
    return { content, isError: !result.success };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Tool execution failed: ${message}` }],
      isError: true,
    };
  }
}

export class WriterMCPServer {
  private readonly supportedProtocols = ['2025-06-18', '2024-11-05'] as const;
  private readonly defaultProtocol = '2024-11-05';

  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = request;

    // JSON-RPC notifications (no id) must never receive a response.
    if (id === undefined) {
      return null;
    }
    const responseId = id;

    try {
      let result: unknown;

      switch (method) {
        case 'initialize': {
          const requestedProtocol =
            params && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
          const protocolVersion =
            requestedProtocol && this.supportedProtocols.includes(requestedProtocol as any)
              ? requestedProtocol
              : this.defaultProtocol;
          result = {
            protocolVersion,
            serverInfo: { name: 'nebula-writer-mcp', version: '0.1.0' },
            capabilities: { tools: {} },
          };
          break;
        }

        case 'tools/list':
          result = { tools: getToolDefinitions() };
          break;

        case 'tools/call': {
          const callParams = params as { name: string; arguments?: Record<string, unknown> };
          console.error(`[Writer MCP] Executing tool: ${callParams.name}`);
          result = await executeToolForMCP(callParams.name, callParams.arguments ?? {});
          break;
        }

        case 'notifications/initialized':
          return null;

        default:
          return {
            jsonrpc: '2.0',
            id: responseId,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }

      return { jsonrpc: '2.0', id: responseId, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        jsonrpc: '2.0',
        id: responseId,
        error: { code: -32603, message: `Internal error: ${message}` },
      };
    }
  }

  async start(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    console.error('Nebula Writer MCP server started.');
    console.error('Tools talk to the Writer sidecar (default http://127.0.0.1:8787); start it with `npm run sidecar`.');

    rl.on('line', async (line) => {
      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const response = await this.handleRequest(request);
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch {
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32700, message: 'Parse error' },
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    });

    rl.on('close', () => {
      console.error('Nebula Writer MCP server stopped');
      process.exit(0);
    });
  }
}
