import type { SyncRemoteConfig } from '@ai-usage/report-core/project-alias';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { listSyncRemotes } from '@ai-usage/local-collectors/sync-storage';
import { Effect } from 'effect';
import { lanHosts } from './server';
import { readSnapshotEndpointHealth } from './transport';

export interface DiscoverSnapshotRemotesInput {
  port?: number;
  hosts?: string[];
  token?: string | null;
  timeoutMs?: number;
  configuredRemotes?: SyncRemoteConfig[];
  localMachine?: UsageMachine;
}

export interface DiscoveredSnapshotRemote {
  host: string;
  healthUrl: string;
  snapshotUrl: string;
  machineId: string;
  machineLabel: string;
  self: boolean;
  alreadyConfigured: boolean;
  lastSeenAt: string;
}

export const snapshotUrlForHost = (host: string, port = 3847) => `http://${host}:${port}/snapshot`;

export const healthUrlForHost = (host: string, port = 3847) => `http://${host}:${port}/health`;

export const subnetHostsForAddress = (address: string) => {
  const parts = address.split('.');
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join('.');
  return Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`).filter((host) => host !== address);
};

export const defaultDiscoveryHosts = () => [...new Set(lanHosts().flatMap(subnetHostsForAddress))];

const configuredUrlSet = (remotes: SyncRemoteConfig[] | undefined) =>
  new Set((remotes ?? []).map((remote) => remote.url));

export const discoverSnapshotRemotes = (
  input: DiscoverSnapshotRemotesInput = {},
): Effect.Effect<DiscoveredSnapshotRemote[]> =>
  Effect.gen(function* () {
    const port = input.port ?? 3847;
    const hosts = [...new Set(input.hosts ?? defaultDiscoveryHosts())];
    const configured = configuredUrlSet(input.configuredRemotes);
    const byMachine = new Map<string, DiscoveredSnapshotRemote>();

    yield* Effect.all(
      hosts.map((host) =>
        readSnapshotEndpointHealth(healthUrlForHost(host, port), input.token ?? null, {
          timeoutMs: input.timeoutMs ?? 800,
        }).pipe(
          Effect.map((health) => {
            const discovered: DiscoveredSnapshotRemote = {
              host,
              healthUrl: healthUrlForHost(host, port),
              snapshotUrl: snapshotUrlForHost(host, port),
              machineId: health.machine.id,
              machineLabel: health.machine.label,
              self: input.localMachine?.id === health.machine.id,
              alreadyConfigured: configured.has(snapshotUrlForHost(host, port)),
              lastSeenAt: new Date().toISOString(),
            };
            const existing = byMachine.get(discovered.machineId);
            if (!existing || existing.alreadyConfigured === false) byMachine.set(discovered.machineId, discovered);
          }),
          Effect.catchAll(() => Effect.void),
        ),
      ),
      { concurrency: 32 },
    );

    return [...byMachine.values()].sort(
      (a, b) => Number(a.self) - Number(b.self) || a.machineLabel.localeCompare(b.machineLabel) || a.host.localeCompare(b.host),
    );
  });

export const discoverConfiguredSnapshotRemotes = (
  input: Omit<DiscoverSnapshotRemotesInput, 'configuredRemotes' | 'localMachine'> = {},
) =>
  Effect.gen(function* () {
    const localMachine = yield* ensureMachineConfig;
    const configuredRemotes = yield* listSyncRemotes;
    return yield* discoverSnapshotRemotes({ ...input, configuredRemotes, localMachine });
  });
