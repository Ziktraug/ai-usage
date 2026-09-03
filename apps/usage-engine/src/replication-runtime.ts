import { loadPrivateDeviceCredential } from '@ai-usage/identity/private-device-credential';
import type { LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import { type MemoryItemId, parseCaptureContextId, parseInstant, type SpaceId } from '@ai-usage/platform-core/identity';
import {
  createHttpReplicationTransport,
  type HttpReplicationClient,
  type ReplicationClientConfig,
  ReplicationClientError,
} from '@ai-usage/replication-client';
import type { ReplicationOutboxStatus } from '@ai-usage/replication-outbox';
import {
  type ReplicationWorkerCycleResult,
  type ReplicationWorkerOutboxPort,
  runReplicationWorkerCycle,
} from '@ai-usage/replication-outbox/worker';
import {
  type CaptureContextSnapshot,
  type ReplicationProblemCode,
  replicationEventIdForSeed,
} from '@ai-usage/replication-protocol';
import {
  parseUsageEngineReplicationStatusOutput,
  type UsageEngineReplicationStatusOutput,
} from '@ai-usage/usage-engine-control';
import {
  backfillUsageReplicationPages,
  createUsageReplicationOutboxPort,
  initializeUsageReplicationWorker,
  recoverUsageReplicationWorker,
} from '@ai-usage/usage-engine-runtime/replication';

const defaultCycleIntervalMs = 30_000;
const maximumEventsPerCycle = 100;

export type DeviceReplicationDiagnosticCode =
  | 'acknowledged'
  | 'blocked'
  | 'configuration-invalid'
  | 'credential-missing'
  | 'credential-unavailable'
  | 'device-rejected'
  | 'device-unreachable'
  | 'idle'
  | 'retry-scheduled'
  | 'setup-failed';

export interface DeviceReplicationDiagnostic {
  readonly code: DeviceReplicationDiagnosticCode;
  readonly problemCode?: ReplicationProblemCode;
  readonly streamId?: 'memory-v1' | 'usage-v1';
}

export interface DeviceReplicationRuntimeStatus {
  readonly lastDiagnostic: DeviceReplicationDiagnostic | null;
  readonly memory: ReplicationOutboxStatus | null;
  readonly state: 'connecting' | 'disposed' | 'publishing' | 'waiting';
  readonly usage: ReplicationOutboxStatus | null;
}

export interface DeviceReplicationRuntime {
  readonly dispose: () => Promise<void>;
  readonly runNow: () => Promise<void>;
  readonly status: () => DeviceReplicationRuntimeStatus;
}

export const localOnlyReplicationStatus = (): UsageEngineReplicationStatusOutput =>
  parseUsageEngineReplicationStatusOutput({
    kind: 'replication-status',
    lastDiagnostic: null,
    memory: null,
    mode: 'local-only',
    runtimeState: 'disabled',
    usage: null,
  });

export const deviceReplicationStatusOutput = (
  status: DeviceReplicationRuntimeStatus,
): UsageEngineReplicationStatusOutput =>
  parseUsageEngineReplicationStatusOutput({
    kind: 'replication-status',
    lastDiagnostic:
      status.lastDiagnostic === null
        ? null
        : {
            code: status.lastDiagnostic.code,
            problemCode: status.lastDiagnostic.problemCode ?? null,
            streamId: status.lastDiagnostic.streamId ?? null,
          },
    memory: status.memory,
    mode: 'connected',
    runtimeState: status.state,
    usage: status.usage,
  });

interface DeviceReplicationRuntimeDependencies {
  readonly acquireClient: () => Promise<HttpReplicationClient | null>;
  readonly clock?: () => Date;
  readonly cycleIntervalMs?: number;
  readonly reportDiagnostic?: (diagnostic: DeviceReplicationDiagnostic) => void;
  readonly schedule?: (operation: () => void, delayMilliseconds: number) => ReturnType<typeof setTimeout>;
}

export interface StartDeviceReplicationRuntimeInput extends DeviceReplicationRuntimeDependencies {
  readonly kernel: LocalIdentityKernel;
  readonly usageDatabasePath: string;
}

export interface StartConfiguredDeviceReplicationInput {
  readonly allowInsecureLoopback?: boolean;
  readonly baseUrl: string;
  readonly kernel: LocalIdentityKernel;
  readonly reportDiagnostic?: (diagnostic: DeviceReplicationDiagnostic) => void;
  readonly stateDirectory: string;
  readonly usageDatabasePath: string;
}

interface PreparedReplication {
  readonly captureContext: CaptureContextSnapshot;
  readonly client: HttpReplicationClient;
  readonly deviceLabel: string;
  readonly localSpaceId: SpaceId;
  readonly memoryOutbox: ReplicationWorkerOutboxPort;
  readonly usageOutbox: ReplicationWorkerOutboxPort;
}

const createMemoryReplicationOutboxPort = (kernel: LocalIdentityKernel): ReplicationWorkerOutboxPort => ({
  acknowledge: (batch, ack) => {
    kernel.replication.acknowledge(batch, ack);
    return Promise.resolve();
  },
  block: (input) => {
    kernel.replication.block(input);
    return Promise.resolve();
  },
  claimReady: (input) => Promise.resolve(kernel.replication.claimReady(input)),
  retry: (input) => Promise.resolve(kernel.replication.retry(input)),
  status: () => Promise.resolve(kernel.replication.status()),
});

export const defaultReplicationCaptureContext = (
  device: Awaited<ReturnType<HttpReplicationClient['resolveDevice']>> & { readonly kind: 'resolved' },
): CaptureContextSnapshot => {
  const { ownerPersonId: personId, owningSpaceId: spaceId } = device.value.device;
  return {
    deviceId: device.value.device.id,
    id: parseCaptureContextId(
      replicationEventIdForSeed({
        deviceId: device.value.device.id,
        kind: 'default-personal-capture-context-v1',
        personId,
        spaceId,
      }),
    ),
    personId,
    projectId: null,
    scmAccountId: null,
    scmInstallationId: null,
    source: 'personal-fallback',
    spaceId,
  };
};

const diagnosticForWorkerResult = (
  result: ReplicationWorkerCycleResult,
  streamId: 'memory-v1' | 'usage-v1',
): DeviceReplicationDiagnostic => {
  if (result.kind === 'blocked') {
    return { code: 'blocked', problemCode: result.reason as ReplicationProblemCode, streamId };
  }
  if (result.kind === 'retry-scheduled') {
    return {
      code: 'retry-scheduled',
      ...(result.reason === 'unreachable' || result.reason === 'cancelled'
        ? {}
        : { problemCode: result.reason as ReplicationProblemCode }),
      streamId,
    };
  }
  return { code: result.kind === 'acknowledged' ? 'acknowledged' : 'idle', streamId };
};

const copyStatus = (status: DeviceReplicationRuntimeStatus): DeviceReplicationRuntimeStatus => ({
  lastDiagnostic: status.lastDiagnostic ? { ...status.lastDiagnostic } : null,
  memory: status.memory ? { ...status.memory } : null,
  state: status.state,
  usage: status.usage ? { ...status.usage } : null,
});

export const startDeviceReplicationRuntime = (input: StartDeviceReplicationRuntimeInput): DeviceReplicationRuntime => {
  const clock = input.clock ?? (() => new Date());
  const cycleIntervalMs = input.cycleIntervalMs ?? defaultCycleIntervalMs;
  if (!Number.isSafeInteger(cycleIntervalMs) || cycleIntervalMs <= 0 || cycleIntervalMs > 3_600_000) {
    throw new Error('The replication cycle interval is invalid.');
  }
  const schedule = input.schedule ?? ((operation, delayMilliseconds) => setTimeout(operation, delayMilliseconds));
  const controller = new AbortController();
  let disposed = false;
  let prepared: PreparedReplication | null = null;
  let client: HttpReplicationClient | null = null;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let memoryBackfillCursor: MemoryItemId | null = null;
  let usageBackfillCursor: string | null = null;
  let currentStatus: DeviceReplicationRuntimeStatus = {
    lastDiagnostic: null,
    memory: null,
    state: 'connecting',
    usage: null,
  };

  const report = (diagnostic: DeviceReplicationDiagnostic): void => {
    currentStatus = { ...currentStatus, lastDiagnostic: diagnostic };
    input.reportDiagnostic?.(diagnostic);
  };

  const prepare = async (): Promise<PreparedReplication | null> => {
    currentStatus = { ...currentStatus, state: 'connecting' };
    if (!client) {
      try {
        client = await input.acquireClient();
      } catch (error) {
        report({ code: error instanceof ReplicationClientError ? 'configuration-invalid' : 'credential-unavailable' });
        return null;
      }
      if (!client) {
        report({ code: 'credential-missing' });
        return null;
      }
    }
    let resolution: Awaited<ReturnType<HttpReplicationClient['resolveDevice']>>;
    try {
      resolution = await client.resolveDevice(controller.signal);
    } catch {
      report({ code: 'device-unreachable' });
      return null;
    }
    if (resolution.kind === 'problem') {
      report({ code: 'device-rejected', problemCode: resolution.problem.code });
      if (resolution.problem.code === 'revoked' || resolution.problem.code === 'unauthenticated') {
        client = null;
      }
      return null;
    }
    const captureContext = defaultReplicationCaptureContext(resolution);
    let localSpaceId: SpaceId | null = null;
    try {
      const bootstrap = await input.kernel.getBootstrapIdentity();
      localSpaceId = bootstrap.space.id;
      const configured = await input.kernel.configureReplication({
        captureContext,
        configuredAt: clock(),
        localProjectId: null,
        localSpaceId: bootstrap.space.id,
      });
      memoryBackfillCursor = configured.nextCursor;
      await initializeUsageReplicationWorker(input.usageDatabasePath, captureContext.deviceId, clock());
      const recoveredAt = parseInstant(clock().toISOString(), 'replication.recoveredAt');
      input.kernel.replication.recoverInFlight(recoveredAt);
      await recoverUsageReplicationWorker(input.usageDatabasePath, clock());
    } catch {
      report({ code: 'setup-failed' });
      return null;
    }
    if (localSpaceId === null) {
      report({ code: 'setup-failed' });
      return null;
    }
    return {
      captureContext,
      client,
      deviceLabel: resolution.value.device.label,
      localSpaceId,
      memoryOutbox: createMemoryReplicationOutboxPort(input.kernel),
      usageOutbox: createUsageReplicationOutboxPort(input.usageDatabasePath),
    };
  };

  const runCycle = async (): Promise<void> => {
    if (disposed || controller.signal.aborted) {
      return;
    }
    prepared ??= await prepare();
    if (!prepared || disposed || controller.signal.aborted) {
      currentStatus = { ...currentStatus, state: 'waiting' };
      return;
    }
    currentStatus = { ...currentStatus, state: 'publishing' };
    try {
      if (memoryBackfillCursor !== null) {
        const memoryBackfill = await input.kernel.backfillReplication({
          afterItemId: memoryBackfillCursor,
          enqueuedAt: clock(),
          localProjectId: null,
          localSpaceId: prepared.localSpaceId,
          maximumItems: 500,
        });
        memoryBackfillCursor = memoryBackfill.nextCursor;
      }
      const backfill = await backfillUsageReplicationPages({
        afterRowKey: usageBackfillCursor,
        captureContext: prepared.captureContext,
        dbPath: input.usageDatabasePath,
        deviceLabel: prepared.deviceLabel,
        enqueuedAt: clock(),
        maximumPages: 2,
        pageSize: 500,
      });
      usageBackfillCursor = backfill.nextCursor;
      const usageResult = await runReplicationWorkerCycle({
        clock,
        maximumEvents: maximumEventsPerCycle,
        outbox: prepared.usageOutbox,
        signal: controller.signal,
        transport: prepared.client,
      });
      currentStatus = { ...currentStatus, usage: usageResult.status };
      report(diagnosticForWorkerResult(usageResult, 'usage-v1'));

      const memoryResult = await runReplicationWorkerCycle({
        clock,
        maximumEvents: maximumEventsPerCycle,
        outbox: prepared.memoryOutbox,
        signal: controller.signal,
        transport: prepared.client,
      });
      currentStatus = { ...currentStatus, memory: memoryResult.status };
      report(diagnosticForWorkerResult(memoryResult, 'memory-v1'));
    } catch {
      report({ code: 'setup-failed' });
    } finally {
      if (!disposed) {
        currentStatus = { ...currentStatus, state: 'waiting' };
      }
    }
  };

  const scheduleNext = (): void => {
    if (disposed || timer) {
      return;
    }
    timer = schedule(() => {
      timer = null;
      runNow().catch(() => undefined);
    }, cycleIntervalMs);
    timer.unref?.();
  };

  const runNow = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!running) {
      running = runCycle().finally(() => {
        running = null;
        scheduleNext();
      });
    }
    await running;
  };

  const runtime: DeviceReplicationRuntime = {
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      controller.abort();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await running?.catch(() => undefined);
      currentStatus = { ...currentStatus, state: 'disposed' };
    },
    runNow,
    status: () => copyStatus(currentStatus),
  };
  queueMicrotask(() => {
    runNow().catch(() => undefined);
  });
  return Object.freeze(runtime);
};

export const startConfiguredDeviceReplication = (
  input: StartConfiguredDeviceReplicationInput,
  dependencies: {
    readonly createClient?: (config: ReplicationClientConfig) => HttpReplicationClient;
    readonly loadCredential?: typeof loadPrivateDeviceCredential;
  } = {},
): DeviceReplicationRuntime =>
  startDeviceReplicationRuntime({
    acquireClient: async () => {
      const stored = await (dependencies.loadCredential ?? loadPrivateDeviceCredential)(input.stateDirectory);
      if (!stored) {
        return null;
      }
      return (dependencies.createClient ?? createHttpReplicationTransport)({
        baseUrl: input.baseUrl,
        credentialToken: stored.credential,
        ...(input.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: input.allowInsecureLoopback }),
      });
    },
    kernel: input.kernel,
    ...(input.reportDiagnostic === undefined ? {} : { reportDiagnostic: input.reportDiagnostic }),
    usageDatabasePath: input.usageDatabasePath,
  });
