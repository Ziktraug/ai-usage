import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeLanPairingServiceWithOptions } from '@ai-usage/lan-pairing';
import { createUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { importLocalRows, queryReportRows } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import {
  createUsageMergeBundleHttpHandler,
  createUsageMergePairingEnvelope,
  createUsageMergeRuntime,
  decodeUsageMergeCredential,
  encodeUsageMergeCredential,
  lanIdentityFromMachine,
  resolveUsageMergeBundle,
  storedLanPeerFromPairingEnvelope,
  USAGE_MERGE_PROTOCOL,
  USAGE_MERGE_PROTOCOL_VERSION,
  UsageMergeError,
  upsertUsageMergeEnvToken,
  usageMergeTokenEnvNameForMachine,
} from './index';

const makeSourcedRow = (input: { project: string; sourcePath: string; sessionId: string }): SourcedRow => ({
  ...normalizeUsageRow({
    date: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:01:00.000Z'),
    harness: 'Claude Code',
    provider: 'Claude API',
    name: input.sessionId,
    model: 'claude-sonnet-4-6',
    project: input.project,
    tokens: { in: 10, out: 5, cr: 0, cw: 0 },
    cost: approximateApiCost,
    calls: 1,
  }),
  source: {
    harnessKey: 'claude',
    sourceSessionId: input.sessionId,
    sourcePath: input.sourcePath,
  },
});

describe('usage-merge public boundary', () => {
  test('adapts ai-usage machines into generic LAN identities', () => {
    expect(lanIdentityFromMachine({ id: 'machine-a', label: 'Machine A' })).toEqual({
      id: 'machine-a',
      label: 'Machine A',
      protocol: USAGE_MERGE_PROTOCOL,
      version: USAGE_MERGE_PROTOCOL_VERSION,
    });
  });

  test('uses a typed public error', () => {
    const error = new UsageMergeError({
      message: 'Cannot merge this machine into itself',
      operation: 'mergePeer',
      reason: 'self-merge',
    });

    expect(error._tag).toBe('UsageMergeError');
  });

  test('encodes ai-usage merge credentials into generic pairing envelopes', () => {
    const machine = { id: 'machine-a', label: 'Machine A' };
    const tokenEnv = usageMergeTokenEnvNameForMachine(machine);
    const token = 'secret-token';
    const envelope = createUsageMergePairingEnvelope({ machine, tokenEnv, token });
    const decoded = decodeUsageMergeCredential(envelope.credential);

    expect(tokenEnv).toBe('AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN');
    expect(envelope.peerId).toBe(machine.id);
    expect(envelope.metadata.protocol).toBe(USAGE_MERGE_PROTOCOL);
    expect(decoded).toEqual({ version: 1, tokenEnv, token });
    expect(JSON.stringify(envelope)).not.toContain('secret-token');
  });

  test('creates stored trusted peer records from pairing envelopes', () => {
    const machine = { id: 'machine-b', label: 'Machine B' };
    const identity = lanIdentityFromMachine(machine);
    const envelope = createUsageMergePairingEnvelope({
      machine,
      tokenEnv: usageMergeTokenEnvNameForMachine(machine),
      token: 'secret-token',
    });

    const peer = storedLanPeerFromPairingEnvelope({
      identity,
      envelope,
      pairedAt: new Date('2026-06-19T12:00:00.000Z'),
    });

    expect(peer).toEqual({
      machineId: 'machine-b',
      machineLabel: 'Machine B',
      tokenEnv: 'AI_USAGE_LAN_MERGE_MACHINE_B_TOKEN',
      pairedAt: '2026-06-19T12:00:00.000Z',
      lastSeenAt: '2026-06-19T12:00:00.000Z',
    });
    expect(() =>
      storedLanPeerFromPairingEnvelope({
        identity: lanIdentityFromMachine({ id: 'other', label: 'Other' }),
        envelope,
        pairedAt: new Date(),
      }),
    ).toThrow();
    expect(() =>
      decodeUsageMergeCredential(encodeUsageMergeCredential({ tokenEnv: 'BAD-NAME', token: 'secret' })),
    ).toThrow();
  });

  test('upserts usage merge tokens in the workspace root env file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-usage-merge-env-'));
    try {
      const appCwd = path.join(root, 'apps', 'web');
      mkdirSync(appCwd, { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
      writeFileSync(path.join(root, '.env'), 'AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN=old\nOTHER=value\n');

      const first = upsertUsageMergeEnvToken('AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN', 'new', appCwd);
      const second = upsertUsageMergeEnvToken('AI_USAGE_LAN_MERGE_MACHINE_B_TOKEN', 'secret', appCwd);

      expect(first.path).toBe(path.join(root, '.env'));
      expect(second.path).toBe(path.join(root, '.env'));
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        'AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN=new\nOTHER=value\nAI_USAGE_LAN_MERGE_MACHINE_B_TOKEN=secret\n',
      );
      expect(statSync(path.join(root, '.env')).mode.toString(8).slice(-3)).toBe('600');
      expect(() => upsertUsageMergeEnvToken('INVALID_KEY', 'value', appCwd)).toThrow('Invalid usage merge token');
      expect(() => upsertUsageMergeEnvToken('AI_USAGE_BAD_TOKEN', 'value\ninjected', appCwd)).toThrow(
        'Invalid usage merge token',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves authenticated local merge bundles without HTTP types', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-merge-resolve-'));
    try {
      const dbPath = path.join(home, 'usage.sqlite');
      const machine: UsageMachine = { id: 'machine-a', label: 'Machine A' };
      await Effect.runPromise(
        importLocalRows({
          dbPath,
          machine,
          rows: [makeSourcedRow({ project: 'local-project', sourcePath: '/work/local', sessionId: 'local-1' })],
        }),
      );

      const rejected = await Effect.runPromise(
        resolveUsageMergeBundle({
          machine,
          dbPath,
          expectedToken: 'secret-token',
          providedToken: null,
          generatedAt: new Date('2026-06-19T12:00:00.000Z'),
        }),
      );
      const accepted = await Effect.runPromise(
        resolveUsageMergeBundle({
          machine,
          dbPath,
          expectedToken: 'secret-token',
          providedToken: 'secret-token',
          generatedAt: new Date('2026-06-19T12:00:00.000Z'),
        }),
      );

      expect(rejected.kind).toBe('unauthorized');
      expect(accepted.kind).toBe('ready');
      if (accepted.kind !== 'ready') {
        throw new Error('Expected authenticated merge bundle');
      }
      expect(JSON.stringify(accepted.bundle)).not.toContain('secret-token');
      expect(accepted.bundle).toMatchObject({
        machine,
        generatedAt: '2026-06-19T12:00:00.000Z',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('serves authenticated local merge bundles without exposing the token', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-merge-handler-'));
    try {
      const dbPath = path.join(home, 'usage.sqlite');
      const machine: UsageMachine = { id: 'machine-a', label: 'Machine A' };
      await Effect.runPromise(
        importLocalRows({
          dbPath,
          machine,
          rows: [makeSourcedRow({ project: 'local-project', sourcePath: '/work/local', sessionId: 'local-1' })],
        }),
      );

      const handler = createUsageMergeBundleHttpHandler({
        machine,
        dbPath,
        token: 'secret-token',
        generatedAt: () => new Date('2026-06-19T12:00:00.000Z'),
      });

      const rejected = await handler(new Request('http://127.0.0.1/lan/merge-bundle'));
      const accepted = await handler(
        new Request('http://127.0.0.1/lan/merge-bundle', {
          headers: { authorization: 'Bearer secret-token' },
        }),
      );
      const text = await accepted.text();

      expect(rejected.status).toBe(401);
      expect(accepted.status).toBe(200);
      expect(text).not.toContain('secret-token');
      expect(JSON.parse(text)).toMatchObject({
        machine,
        generatedAt: '2026-06-19T12:00:00.000Z',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('merges a paired peer bundle into the local usage store and updates peer state', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-merge-peer-'));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const localMachine: UsageMachine = { id: 'local-machine', label: 'Local Machine' };
      const peerMachine: UsageMachine = { id: 'peer-machine', label: 'Peer Machine' };
      const localDbPath = path.join(home, 'local.sqlite');
      const peerDbPath = path.join(home, 'peer.sqlite');
      await Effect.runPromise(
        importLocalRows({
          dbPath: peerDbPath,
          machine: peerMachine,
          rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-1' })],
        }),
      );

      server = Bun.serve({
        port: 0,
        fetch: createUsageMergeBundleHttpHandler({
          machine: peerMachine,
          dbPath: peerDbPath,
          token: 'peer-token',
          generatedAt: () => new Date('2026-06-19T12:00:00.000Z'),
        }),
      });

      const runtime = createUsageMergeRuntime({
        localMachine,
        dbPath: localDbPath,
        peers: [
          {
            machineId: peerMachine.id,
            machineLabel: peerMachine.label,
            tokenEnv: 'AI_USAGE_LAN_MERGE_PEER_TOKEN',
            pairedAt: '2026-06-19T11:00:00.000Z',
          },
        ],
        peerUrls: { [peerMachine.id]: `http://${server.hostname}:${server.port}/lan/merge-bundle` },
        getToken: () => 'peer-token',
        now: () => new Date('2026-06-19T12:30:00.000Z'),
      });

      const result = await Effect.runPromise(runtime.mergePeer({ machineId: peerMachine.id }));
      const rows = await Effect.runPromise(
        queryReportRows({ dbPath: localDbPath, originMachineIds: [peerMachine.id] }),
      );
      const state = await Effect.runPromise(runtime.getLanMergeState());

      expect(result.inserted).toBe(1);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.project).toBe('peer-project');
      expect(state.trustedPeers[0]).toMatchObject({
        machineId: peerMachine.id,
        online: true,
        rows: 1,
        warnings: 0,
        lastMergedAt: '2026-06-19T12:30:00.000Z',
      });
    } finally {
      server?.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reports missing token and offline peer recovery errors', async () => {
    const runtime = createUsageMergeRuntime({
      localMachine: { id: 'local-machine', label: 'Local Machine' },
      dbPath: path.join(tmpdir(), 'unused.sqlite'),
      peers: [
        {
          machineId: 'peer-machine',
          machineLabel: 'Peer Machine',
          tokenEnv: 'AI_USAGE_LAN_MERGE_PEER_TOKEN',
          pairedAt: '2026-06-19T11:00:00.000Z',
        },
      ],
      peerUrls: {},
      getToken: () => undefined,
    });

    const missingToken = await Effect.runPromise(runtime.mergePeer({ machineId: 'peer-machine' }).pipe(Effect.flip));
    expect(missingToken.reason).toBe('missing-token');

    const offlineRuntime = createUsageMergeRuntime({
      localMachine: { id: 'local-machine', label: 'Local Machine' },
      dbPath: path.join(tmpdir(), 'unused.sqlite'),
      peers: [
        {
          machineId: 'peer-machine',
          machineLabel: 'Peer Machine',
          tokenEnv: 'AI_USAGE_LAN_MERGE_PEER_TOKEN',
          pairedAt: '2026-06-19T11:00:00.000Z',
        },
      ],
      peerUrls: {},
      getToken: () => 'peer-token',
    });

    const offline = await Effect.runPromise(offlineRuntime.mergePeer({ machineId: 'peer-machine' }).pipe(Effect.flip));
    expect(offline.reason).toBe('peer-offline');
    const state = await Effect.runPromise(offlineRuntime.getLanMergeState());
    expect(state.service.lastError).toContain('offline');
  });

  test('uses a merge URL supplied by the caller for a paired peer', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-merge-url-'));
    try {
      const peerMachine: UsageMachine = { id: 'peer-machine', label: 'Peer Machine' };
      let requestedUrl = '';
      const runtime = createUsageMergeRuntime({
        localMachine: { id: 'local-machine', label: 'Local Machine' },
        dbPath: path.join(home, 'usage.sqlite'),
        peers: [
          {
            machineId: peerMachine.id,
            machineLabel: peerMachine.label,
            tokenEnv: 'AI_USAGE_LAN_MERGE_PEER_TOKEN',
            pairedAt: '2026-06-19T11:00:00.000Z',
          },
        ],
        getToken: () => 'peer-token',
        transport: {
          fetchMergeBundle: ({ url }) => {
            requestedUrl = url;
            return Effect.succeed(
              createUsageMergeBundle({
                machine: peerMachine,
                rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-1' })],
              }),
            );
          },
        },
      });

      await Effect.runPromise(
        runtime.mergePeer({ machineId: peerMachine.id, url: 'http://192.168.1.44:3847/lan/merge-bundle' }),
      );

      expect(requestedUrl).toBe('http://192.168.1.44:3847/lan/merge-bundle');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('exports local usage as a manual merge bundle file', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-manual-export-'));
    try {
      const localMachine: UsageMachine = { id: 'local-machine', label: 'Local Machine' };
      const dbPath = path.join(home, 'usage.sqlite');
      await Effect.runPromise(
        importLocalRows({
          dbPath,
          machine: localMachine,
          rows: [makeSourcedRow({ project: 'local-project', sourcePath: '/work/local', sessionId: 'local-1' })],
        }),
      );

      const runtime = createUsageMergeRuntime({
        localMachine,
        dbPath,
        peers: [],
        now: () => new Date('2026-06-19T12:30:00.000Z'),
      });

      const exported = await Effect.runPromise(runtime.exportManualMergeBundle());

      expect(exported.filename).toBe('ai-usage-local-machine-2026-06-19T12-30-00-000Z.json');
      expect(exported.bundle.machine).toEqual(localMachine);
      expect(exported.bundle.rows).toHaveLength(1);
      expect(exported.bundle.rows[0]?.source.machineId).toBe(localMachine.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('imports a manual merge bundle without trusting the peer', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-manual-import-'));
    try {
      const localMachine: UsageMachine = { id: 'local-machine', label: 'Local Machine' };
      const peerMachine: UsageMachine = { id: 'peer-machine', label: 'Peer Machine' };
      const dbPath = path.join(home, 'usage.sqlite');
      const bundle = createUsageMergeBundle({
        machine: peerMachine,
        rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-1' })],
        warnings: [{ message: 'manual warning' }],
      });
      const runtime = createUsageMergeRuntime({
        localMachine,
        dbPath,
        peers: [],
        now: () => new Date('2026-06-19T12:30:00.000Z'),
      });

      const imported = await Effect.runPromise(runtime.importManualMergeBundle({ text: JSON.stringify(bundle) }));
      const repeated = await Effect.runPromise(runtime.importManualMergeBundle({ text: JSON.stringify(bundle) }));
      const rows = await Effect.runPromise(queryReportRows({ dbPath, originMachineIds: [peerMachine.id] }));
      const state = await Effect.runPromise(runtime.getLanMergeState());

      expect(imported).toMatchObject({
        machine: peerMachine,
        rows: 1,
        warnings: 1,
        result: { inserted: 1 },
      });
      expect(repeated.result.unchanged).toBe(1);
      expect(rows.rows[0]?.project).toBe('peer-project');
      expect(state.trustedPeers).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects manual self-imports', async () => {
    const localMachine: UsageMachine = { id: 'local-machine', label: 'Local Machine' };
    const runtime = createUsageMergeRuntime({
      localMachine,
      dbPath: path.join(tmpdir(), 'unused.sqlite'),
      peers: [],
    });
    const bundle = createUsageMergeBundle({
      machine: localMachine,
      rows: [makeSourcedRow({ project: 'local-project', sourcePath: '/work/local', sessionId: 'local-1' })],
    });

    const error = await Effect.runPromise(
      runtime.importManualMergeBundle({ text: JSON.stringify(bundle) }).pipe(Effect.flip),
    );

    expect(error.reason).toBe('self-merge');
  });

  test('runs the first merge when pairing a trusted discovered peer', async () => {
    const peerMachine: UsageMachine = { id: 'peer-machine', label: 'Peer Machine' };
    const runtime = createUsageMergeRuntime({
      localMachine: { id: 'local-machine', label: 'Local Machine' },
      dbPath: path.join(tmpdir(), 'unused.sqlite'),
      peers: [
        {
          machineId: peerMachine.id,
          machineLabel: peerMachine.label,
          tokenEnv: 'AI_USAGE_LAN_MERGE_PEER_TOKEN',
          pairedAt: '2026-06-19T11:00:00.000Z',
        },
      ],
      discoveredPeers: [
        {
          identity: lanIdentityFromMachine(peerMachine),
          host: '127.0.0.1',
          port: 5000,
          online: true,
          pairingAvailable: true,
          self: false,
          lastSeenAt: '2026-06-19T11:00:00.000Z',
        },
      ],
      peerUrls: { [peerMachine.id]: 'memory://peer/lan/merge-bundle' },
      getToken: () => 'peer-token',
      transport: {
        fetchMergeBundle: () =>
          Effect.succeed(
            createUsageMergeBundle({
              machine: peerMachine,
              rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-1' })],
            }),
          ),
      },
      now: () => new Date('2026-06-19T12:30:00.000Z'),
    });

    const state = await Effect.runPromise(runtime.pairPeer({ discoveredPeerId: peerMachine.id, password: '123456' }));

    expect(state.trustedPeers[0]?.lastMergedAt).toBe('2026-06-19T12:30:00.000Z');
    expect(state.trustedPeers[0]?.rows).toBe(1);
  });

  test('pairs a new LAN peer, persists both trusted records, and runs the first merge', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-merge-lan-pair-'));
    let runtimeA: ReturnType<typeof createUsageMergeRuntime> | undefined;
    let runtimeB: ReturnType<typeof createUsageMergeRuntime> | undefined;
    try {
      const machineA: UsageMachine = { id: 'machine-a', label: 'Machine A' };
      const machineB: UsageMachine = { id: 'machine-b', label: 'Machine B' };
      const dbA = path.join(home, 'a.sqlite');
      const dbB = path.join(home, 'b.sqlite');
      const tokensA = new Map<string, string>();
      const tokensB = new Map<string, string>();
      const storedA: Array<{ machineId: string }> = [];
      const storedB: Array<{ machineId: string }> = [];
      const serviceA = await Effect.runPromise(
        makeLanPairingServiceWithOptions({ discoveryHosts: ['127.0.0.1'], discoveryTimeoutMs: 100 }),
      );
      const serviceB = await Effect.runPromise(
        makeLanPairingServiceWithOptions({ discoveryHosts: ['127.0.0.1'], discoveryTimeoutMs: 100 }),
      );

      await Effect.runPromise(
        importLocalRows({
          dbPath: dbA,
          machine: machineA,
          rows: [makeSourcedRow({ project: 'local-project', sourcePath: '/work/local', sessionId: 'local-1' })],
        }),
      );
      await Effect.runPromise(
        importLocalRows({
          dbPath: dbB,
          machine: machineB,
          rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-1' })],
        }),
      );

      runtimeA = createUsageMergeRuntime({
        localMachine: machineA,
        dbPath: dbA,
        peers: [],
        lanPairing: serviceA,
        localToken: 'token-a',
        getToken: (key) => tokensA.get(key),
        persistToken: (key, value) => {
          tokensA.set(key, value);
        },
        persistTrustedPeer: (peer) => {
          storedA.push(peer);
        },
        now: () => new Date('2026-06-19T12:30:00.000Z'),
      });
      runtimeB = createUsageMergeRuntime({
        localMachine: machineB,
        dbPath: dbB,
        peers: [],
        lanPairing: serviceB,
        localToken: 'token-b',
        getToken: (key) => tokensB.get(key),
        persistToken: (key, value) => {
          tokensB.set(key, value);
        },
        persistTrustedPeer: (peer) => {
          storedB.push(peer);
        },
        now: () => new Date('2026-06-19T12:30:00.000Z'),
      });

      await Effect.runPromise(runtimeA.startLanMerge());
      await Effect.runPromise(runtimeB.startLanMerge());
      await Effect.runPromise(runtimeA.scanLanMergePeers());
      await Effect.runPromise(runtimeB.scanLanMergePeers());

      await Effect.runPromise(
        runtimeB.pairPeer({ discoveredPeerId: machineA.id, password: '123456' }).pipe(Effect.either),
      );
      const stateA = await Effect.runPromise(runtimeA.pairPeer({ discoveredPeerId: machineB.id, password: '123456' }));
      const rowsA = await Effect.runPromise(queryReportRows({ dbPath: dbA, originMachineIds: [machineB.id] }));
      const rowsB = await Effect.runPromise(queryReportRows({ dbPath: dbB, originMachineIds: [machineA.id] }));

      expect(storedA.map((peer) => peer.machineId)).toContain(machineB.id);
      expect(storedB.map((peer) => peer.machineId)).toContain(machineA.id);
      expect(tokensA.get('AI_USAGE_LAN_MERGE_MACHINE_B_TOKEN')).toBe('token-b');
      expect(tokensB.get('AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN')).toBe('token-a');
      expect(rowsA.rows[0]?.project).toBe('peer-project');
      expect(rowsB.rows[0]?.project).toBe('local-project');
      expect(stateA.trustedPeers.find((peer) => peer.machineId === machineB.id)?.lastMergedAt).toBe(
        '2026-06-19T12:30:00.000Z',
      );
    } finally {
      if (runtimeA) {
        try {
          await Effect.runPromise(runtimeA.stopLanMerge());
        } catch {
          // Best-effort cleanup so a failed assertion does not leave the test port bound.
        }
      }
      if (runtimeB) {
        try {
          await Effect.runPromise(runtimeB.stopLanMerge());
        } catch {
          // Best-effort cleanup so a failed assertion does not leave the test port bound.
        }
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
