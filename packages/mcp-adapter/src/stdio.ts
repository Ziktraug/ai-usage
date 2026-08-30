import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export const connectMemoryMcpStdio = async (server: McpServer): Promise<void> => {
  await server.connect(new StdioServerTransport());
};
