#!/usr/bin/env bun
import {
  createClientMemoryMcpReadService,
  createMemoryMcpServer,
  type WorkContextMcpReadService,
} from '@ai-usage/mcp-adapter';
import { connectMemoryMcpStdio } from '@ai-usage/mcp-adapter/stdio';
import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import { readWorkContext } from '@ai-usage/report-data/work-context-read';
import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';
import { usageStorePath } from '@ai-usage/usage-store/reader';

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

/**
 * `work.context` over the usage store the CLI and the web read (`AI_USAGE_DATABASE_PATH`, else the
 * home store), through `report-data`'s read-only connection (ADR 0058). The store is opened per
 * call and never created; only the failure code crosses the MCP edge.
 */
export const createLocalWorkContextMcpReadService = (dbPath: string): WorkContextMcpReadService => ({
  readWorkContext: async (scope, signal, options) => {
    const result = await readWorkContext({ dbPath, scope, signal, ...options });
    return result.kind === 'success'
      ? { kind: 'success', value: result.value }
      : { code: result.failure.code, kind: 'error' };
  },
});

export const runMemoryMcpProcess = async (
  dependencies: MemoryMcpProcessDependencies = defaultDependencies,
): Promise<void> => {
  const runtimePaths = resolveUsageRuntimePaths({
    cwd: dependencies.cwd,
    databasePathForHome: usageStorePath,
    env: dependencies.environment,
  });
  const rendezvousPath = memoryServiceRendezvousPath(runtimePaths.stateDirectory);
  const client = createMemoryServiceClient({
    resolveRendezvous: async () => await loadMemoryServiceRendezvous(rendezvousPath),
  });
  const server = createMemoryMcpServer(createClientMemoryMcpReadService(client), {
    work: createLocalWorkContextMcpReadService(runtimePaths.databasePath),
  });
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
