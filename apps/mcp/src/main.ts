#!/usr/bin/env bun
import path from 'node:path';
import { createClientMemoryMcpReadService, createMemoryMcpServer } from '@ai-usage/mcp-adapter';
import { connectMemoryMcpStdio } from '@ai-usage/mcp-adapter/stdio';
import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';

export interface MemoryMcpProcessDependencies {
  readonly connect: typeof connectMemoryMcpStdio;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

const defaultDependencies: MemoryMcpProcessDependencies = {
  connect: connectMemoryMcpStdio,
  cwd: process.cwd(),
  environment: process.env,
};

export const runMemoryMcpProcess = async (
  dependencies: MemoryMcpProcessDependencies = defaultDependencies,
): Promise<void> => {
  const runtimePaths = resolveUsageRuntimePaths({
    cwd: dependencies.cwd,
    databasePathForHome: (homeDirectory) => path.join(homeDirectory, '.local', 'share', 'ai-usage', 'usage.sqlite'),
    env: dependencies.environment,
  });
  const rendezvousPath = memoryServiceRendezvousPath(runtimePaths.stateDirectory);
  const client = createMemoryServiceClient({
    resolveRendezvous: async () => await loadMemoryServiceRendezvous(rendezvousPath),
  });
  const server = createMemoryMcpServer(createClientMemoryMcpReadService(client));
  await dependencies.connect(server);
};

if (import.meta.main) {
  try {
    await runMemoryMcpProcess();
  } catch {
    process.stderr.write('ai-usage Memory MCP failed to start.\n');
    process.exitCode = 1;
  }
}
