import { createMemoryServiceClient, type MemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import { Context, Layer } from 'effect';
import { type CliUsageEngine, createLiveCliUsageEngine } from './usage-engine';
import { type CliUsagePaths, resolveCliUsagePaths } from './usage-paths';

export interface CliRuntime {
  readonly argv: string[];
  readonly memory: MemoryServiceClient;
  readonly paths: CliUsagePaths;
  readonly signal: AbortSignal;
  readonly stdoutIsTTY: boolean;
  readonly usageEngine: CliUsageEngine;
}

export const CliRuntime = Context.GenericTag<CliRuntime>('@ai-usage/CliRuntime');

export interface CreateCliRuntimeLayerOptions {
  readonly argv?: string[];
  readonly signal: AbortSignal;
  readonly stdoutIsTTY?: boolean;
}

export const createCliRuntimeLayer = (options: CreateCliRuntimeLayerOptions) => {
  const paths = resolveCliUsagePaths();
  const memoryRendezvousPath = memoryServiceRendezvousPath(paths.stateDirectory);
  return Layer.succeed(CliRuntime, {
    argv: options.argv ?? process.argv.slice(2),
    memory: createMemoryServiceClient({
      resolveRendezvous: async () => await loadMemoryServiceRendezvous(memoryRendezvousPath),
    }),
    paths,
    signal: options.signal,
    stdoutIsTTY: options.stdoutIsTTY ?? !!process.stdout.isTTY,
    usageEngine: createLiveCliUsageEngine({
      paths,
      // Engine diagnostics are already persisted by the engine sink. Draining
      // them here keeps the CLI's established stderr warning/error contract.
      writeDiagnostics: async () => undefined,
    }),
  });
};
