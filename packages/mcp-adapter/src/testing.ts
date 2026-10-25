import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallToolResult, CallToolResultSchema, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Test support for compositions of the adapter's server: one MCP client connected to one server
 * over the SDK's in-memory transport, as a stdio client would be. Keeps the SDK a dependency of the
 * adapter alone; the apps that compose the server test through this seam.
 */

export interface InMemoryMcpClientInfo {
  readonly name: string;
  readonly version?: string;
}

export interface InMemoryMcpClient {
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** Closes the client, then the server. */
  readonly close: () => Promise<void>;
  readonly instructions: () => string | undefined;
  readonly listTools: () => Promise<ListToolsResult['tools']>;
}

export const connectInMemoryMcpClient = async (
  server: McpServer,
  clientInfo: InMemoryMcpClientInfo,
): Promise<InMemoryMcpClient> => {
  const client = new Client({ name: clientInfo.name, version: clientInfo.version ?? '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    // The SDK types the answer as the current or the legacy result shape; only the current one is served.
    callTool: async (name, args) =>
      CallToolResultSchema.parse(await client.callTool({ arguments: args, name }, CallToolResultSchema)),
    close: async () => {
      await client.close();
      await server.close();
    },
    instructions: () => client.getInstructions(),
    listTools: async () => (await client.listTools()).tools,
  };
};
