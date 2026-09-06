/**
 * Writer MCP tool types
 *
 * Standalone copies of the minimal tool contracts the Writer MCP server needs.
 * Unlike the Nebula notebook tools, Writer tools talk to the local Writer
 * sidecar over HTTP and take no client argument.
 */

export interface PropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
  annotations?: {
    /** Tool only reads data, doesn't modify */
    readOnlyHint?: boolean;
    /** Tool modifies or deletes data */
    destructiveHint?: boolean;
  };
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export type MCPContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
>;

export interface Tool<TParams = Record<string, unknown>, TResult = unknown> {
  definition: ToolDefinition;
  execute: (params: TParams) => Promise<ToolResult<TResult>>;
  /** Optional: format result for MCP display. Defaults to JSON. */
  formatForMCP?: (result: ToolResult<TResult>) => MCPContent | Promise<MCPContent>;
}
