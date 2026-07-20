import { describe, expect, test } from 'bun:test';
import { MAX_PORTABLE_USAGE_ROWS } from './portable-usage';
import { createProviderStatusDataset } from './provider-status';
import { createUsageSnapshot, mergeUsageSnapshots, parseUsageSnapshot, serializeUsageSnapshot } from './snapshot';
import type { Row, SourcedRow } from './types';

const row = (name: string, sourceSessionId: string, overrides: Partial<Row> = {}): SourcedRow => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name,
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 10,
  tokOut: 5,
  tokCr: 0,
  tokCw: 0,
  costActual: 0.1,
  costApprox: 0.1,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  source: { harnessKey: 'codex', sourceSessionId },
  ...overrides,
});

const machine = { id: 'machine-1', label: 'Machine 1' };

const currentSnapshot = () =>
  createUsageSnapshot({
    appVersion: null,
    generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    machine,
    rows: [row('a', 'session-1')],
  });

const parseSnapshot = (snapshot: unknown) => () => parseUsageSnapshot(JSON.stringify(snapshot));

describe('usage snapshots', () => {
  test('serializes rows with machine provenance', () => {
    const snapshot = createUsageSnapshot({ machine, rows: [row('a', 'session-1')] });

    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.rows[0]?.source).toMatchObject({
      machineId: 'machine-1',
      machineLabel: 'Machine 1',
      harnessKey: 'codex',
      sourceSessionId: 'session-1',
    });
  });

  test('round-trips snapshots emitted without an application version', () => {
    const snapshot = currentSnapshot();

    expect(parseUsageSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.source.appVersion).toBeNull();
  });

  test('preserves bounded VCS context through a v3 snapshot roundtrip', () => {
    const vcs = {
      branches: [
        {
          firstObservedAt: '2026-01-01T00:00:00.000Z',
          lastObservedAt: '2026-01-01T00:01:00.000Z',
          name: 'main',
          provenance: 'harness-recorded' as const,
          webUrl: 'https://github.com/example/project/tree/main',
        },
      ],
      headCommit: {
        hash: '0123456789abcdef',
        observedAt: '2026-01-01T00:01:00.000Z',
        provenance: 'harness-recorded' as const,
        webUrl: 'https://github.com/example/project/commit/0123456789abcdef',
      },
      partial: false,
      pullRequests: [
        {
          number: 27,
          observedAt: '2026-01-01T00:01:00.000Z',
          repository: 'example/project',
          url: 'https://github.com/example/project/pull/27',
        },
      ],
      repository: {
        host: 'github.com',
        ownerPath: 'example/project',
        provenance: 'harness-recorded' as const,
        webUrl: 'https://github.com/example/project',
      },
    };
    const snapshot = createUsageSnapshot({
      machine,
      rows: [{ ...row('vcs', 'vcs'), source: { harnessKey: 'codex', sourceSessionId: 'vcs', vcs } }],
    });

    expect(parseUsageSnapshot(serializeUsageSnapshot(snapshot)).rows[0]?.source.vcs).toEqual(vcs);
  });

  test('migrates legacy v1/v2 snapshots and rejects newer fields under old versions', () => {
    const snapshot = currentSnapshot();

    expect(parseUsageSnapshot(JSON.stringify({ ...snapshot, schemaVersion: 1 })).schemaVersion).toBe(3);
    expect(parseUsageSnapshot(JSON.stringify({ ...snapshot, schemaVersion: 2 })).schemaVersion).toBe(3);

    const segmented = createUsageSnapshot({
      machine,
      rows: [
        row('segmented', 'segmented', {
          modelSegments: [
            {
              costApprox: 0.1,
              costKnown: true,
              model: 'gpt-5.3-codex',
              tokCr: 0,
              tokCw: 0,
              tokIn: 10,
              tokOut: 5,
            },
          ],
        }),
      ],
    });
    expect(() => parseUsageSnapshot(JSON.stringify({ ...segmented, schemaVersion: 1 }))).toThrow('legacy v1');

    const withVcs = createUsageSnapshot({
      machine,
      rows: [
        {
          ...row('vcs', 'vcs'),
          source: {
            harnessKey: 'codex',
            sourceSessionId: 'vcs',
            vcs: { branches: [], headCommit: null, partial: false, pullRequests: [], repository: null },
          },
        },
      ],
    });
    expect(() => parseUsageSnapshot(JSON.stringify({ ...withVcs, schemaVersion: 2 }))).toThrow('legacy v2');
  });

  test('rejects unknown top-level fields and malformed snapshot identity', () => {
    const snapshot = currentSnapshot();
    const invalidSnapshots = [
      [{ ...snapshot, unexpected: true }, 'unknown fields'],
      [{ ...snapshot, schemaVersion: 4 }, 'schemaVersion'],
      [{ ...snapshot, snapshotId: '' }, 'snapshotId'],
      [{ ...snapshot, generatedAt: '2026-01-01T00:00:00Z' }, 'generatedAt'],
      [{ ...snapshot, machine: { ...snapshot.machine, id: '' } }, 'machine'],
      [{ ...snapshot, machine: { ...snapshot.machine, extra: true } }, 'machine'],
    ] as const;

    for (const [invalidSnapshot, message] of invalidSnapshots) {
      expect(parseSnapshot(invalidSnapshot)).toThrow(message);
    }
  });

  test('validates source platform, hostname, and application version shapes', () => {
    const snapshot = currentSnapshot();
    const withSource = (source: unknown) => ({ ...snapshot, source });
    const invalidSources = [
      { ...snapshot.source, appVersion: '' },
      { ...snapshot.source, appVersion: 1 },
      { ...snapshot.source, hostname: 1 },
      { ...snapshot.source, platform: 'freebsd' },
      { ...snapshot.source, unexpected: true },
      null,
    ];

    for (const source of invalidSources) {
      expect(parseSnapshot(withSource(source))).toThrow('source');
    }

    expect(parseUsageSnapshot(JSON.stringify(withSource({ appVersion: '0.1.0', platform: 'linux' }))).source).toEqual({
      appVersion: '0.1.0',
      platform: 'linux',
    });
  });

  test('rejects malformed metrics, timestamps, and derived row fields atomically', () => {
    const snapshot = currentSnapshot();
    const serialized = snapshot.rows[0]!;
    const invalidRows = [
      { ...serialized, date: 'not-a-date' },
      { ...serialized, endDate: '2026-01-01T00:01:00Z' },
      { ...serialized, tokIn: -1 },
      { ...serialized, tokOut: Number.POSITIVE_INFINITY },
      { ...serialized, calls: 1.5 },
      { ...serialized, durationMs: -1 },
      { ...serialized, costApprox: -0.01 },
      { ...serialized, costActual: -0.01 },
      { ...serialized, linesAdded: 0.5 },
      { ...serialized, activeDate: serialized.date },
      { ...serialized, freshTokens: serialized.freshTokens + 1 },
      { ...serialized, lineDelta: 1 },
      { ...serialized, sessionLabel: 'forged' },
      { ...serialized, tokenTotal: serialized.tokenTotal + 1 },
      { ...serialized, unexpected: true },
    ];

    for (const invalidRow of invalidRows) {
      expect(parseSnapshot({ ...snapshot, rows: [invalidRow] })).toThrow('invalid row');
    }
    expect(() =>
      parseUsageSnapshot(JSON.stringify(snapshot).replace('"costActual":0.1', '"costActual":1e400')),
    ).toThrow('invalid row');
  });

  test('requires strict row source identity and matching machine provenance', () => {
    const snapshot = currentSnapshot();
    const serialized = snapshot.rows[0]!;
    const source = serialized.source;
    const invalidSources = [
      { ...source, harnessKey: '' },
      { ...source, sourceSessionId: 1 },
      { ...source, sourceSessionId: undefined },
      { ...source, machineId: 'forged-machine' },
      { ...source, machineLabel: 'Forged machine' },
      { ...source, unexpected: true },
    ];

    for (const invalidSource of invalidSources) {
      expect(parseSnapshot({ ...snapshot, rows: [{ ...serialized, source: invalidSource }] })).toThrow('row');
    }
  });

  test('validates warnings through the merge-bundle warning contract', () => {
    const snapshot = currentSnapshot();
    const validWarning = {
      groupId: 'group-1',
      groupName: 'Group 1',
      harness: 'codex',
      message: 'Grouping needs attention',
      operation: 'groupProjects',
      path: '/tmp/history.jsonl',
      reason: 'partial-group' as const,
      selectors: [{ machineId: 'machine-1', project: 'ai-usage' }],
      sql: 'select 1',
    };

    expect(parseUsageSnapshot(JSON.stringify({ ...snapshot, warnings: [validWarning] })).warnings).toEqual([
      validWarning,
    ]);

    const invalidWarnings = [
      { ...validWarning, message: 1 },
      { ...validWarning, reason: 'invented-reason' },
      { ...validWarning, selectors: [{}] },
      { ...validWarning, unexpected: true },
    ];
    for (const warning of invalidWarnings) {
      expect(parseSnapshot({ ...snapshot, warnings: [warning] })).toThrow('warnings');
    }
  });

  test('requires JSON-safe object facets', () => {
    const snapshot = currentSnapshot();
    const facets = { nested: { enabled: true, nullable: null }, values: ['a', 1] };

    expect(parseUsageSnapshot(JSON.stringify({ ...snapshot, facets })).facets).toEqual(facets);
    for (const invalidFacets of [null, [], 'facet']) {
      expect(parseSnapshot({ ...snapshot, facets: invalidFacets })).toThrow('facets');
    }
    expect(() =>
      parseUsageSnapshot(JSON.stringify(snapshot).replace('"rows"', '"facets":{"value":1e400},"rows"')),
    ).toThrow('facets');
  });

  test('accepts the manual-merge row boundary and rejects any row beyond it', () => {
    const snapshot = currentSnapshot();
    const rows = Array.from({ length: MAX_PORTABLE_USAGE_ROWS }, () => snapshot.rows[0]);

    expect(parseUsageSnapshot(JSON.stringify({ ...snapshot, rows })).rows).toHaveLength(MAX_PORTABLE_USAGE_ROWS);
    rows.push(snapshot.rows[0]!);
    expect(parseSnapshot({ ...snapshot, rows })).toThrow('50001 rows; maximum is 50000');
  });

  test('serializes one canonical UTF-8 document and enforces its exact byte boundary', () => {
    const snapshot = currentSnapshot();
    const text = serializeUsageSnapshot(snapshot);
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(text.endsWith('\n')).toBe(true);
    expect(serializeUsageSnapshot(snapshot, bytes)).toBe(text);
    expect(() => serializeUsageSnapshot(snapshot, bytes - 1)).toThrow(`${bytes} bytes; maximum is ${bytes - 1}`);
  });

  test('preserves import artifact provenance separately from project paths', () => {
    const artifactPath = '/imports/cursor-usage.csv';
    const snapshot = createUsageSnapshot({
      machine,
      rows: [
        {
          ...row('cursor export', ''),
          project: '',
          source: { harnessKey: 'cursor', sourceSessionId: null, artifactPath },
        },
      ],
    });

    const parsed = parseUsageSnapshot(JSON.stringify(snapshot));
    const [mergedRow] = mergeUsageSnapshots([parsed]).rows;

    expect(parsed.rows[0]?.source.artifactPath).toBe(artifactPath);
    expect(parsed.rows[0]?.source.sourcePath).toBeUndefined();
    expect(mergedRow?.source.artifactPath).toBe(artifactPath);
    expect(mergedRow?.source.sourcePath).toBeUndefined();
  });

  test('preserves per-model attribution through snapshot parsing and merging', () => {
    const modelSegments = [
      {
        costApprox: 0.08,
        costKnown: true,
        model: 'gpt-5.3-codex',
        tokCr: 0,
        tokCw: 0,
        tokIn: 10,
        tokOut: 0,
      },
      {
        costApprox: 0.02,
        costKnown: true,
        model: 'gpt-5.3-codex-mini',
        tokCr: 0,
        tokCw: 0,
        tokIn: 0,
        tokOut: 5,
      },
    ];
    const snapshot = createUsageSnapshot({
      machine,
      rows: [
        row('mixed-model', 'session-mixed', {
          modelSegments,
          models: ['gpt-5.3-codex', 'gpt-5.3-codex-mini'],
          titleSource: 'first-prompt',
        }),
      ],
    });

    const parsed = parseUsageSnapshot(JSON.stringify(snapshot));
    const [mergedRow] = mergeUsageSnapshots([parsed]).rows;

    expect(parsed.rows[0]?.modelSegments).toEqual(modelSegments);
    expect(mergedRow?.modelSegments).toEqual(modelSegments);
    expect(mergedRow?.titleSource).toBe('first-prompt');
  });

  test('parses and dedupes repeated snapshots by source session', () => {
    const older = createUsageSnapshot({
      machine,
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      rows: [row('older', 'session-1', { tokIn: 1 })],
    });
    const newer = createUsageSnapshot({
      machine,
      generatedAt: new Date('2026-01-01T00:05:00.000Z'),
      rows: [row('newer', 'session-1', { tokIn: 2 })],
    });

    const parsed = parseUsageSnapshot(JSON.stringify(older));
    const merged = mergeUsageSnapshots([parsed, newer]);

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]?.name).toBe('newer');
    expect(merged.duplicatesDropped).toBe(1);
    expect(merged.warnings).toHaveLength(1);
  });

  test('serializes and merges report warnings', () => {
    const snapshot = createUsageSnapshot({
      machine,
      rows: [row('a', 'session-1')],
      warnings: [{ harness: 'opencode', operation: 'sqlite.all', message: 'Failed to read OpenCode history' }],
    });

    const parsed = parseUsageSnapshot(JSON.stringify(snapshot));
    const merged = mergeUsageSnapshots([parsed]);

    expect(parsed.warnings?.[0]?.message).toBe('Failed to read OpenCode history');
    expect(merged.warnings[0]).toMatchObject({
      harness: 'opencode',
      operation: 'sqlite.all',
      message: 'Failed to read OpenCode history',
    });
  });

  test('preserves unknown datasets and merges known provider status datasets', () => {
    const providerStatus = createProviderStatusDataset(
      [
        {
          key: 'codex',
          label: 'Codex',
          generatedAt: '2026-01-01T00:00:00.000Z',
          machineId: 'machine-1',
          machineLabel: 'Machine 1',
          source: 'local-history',
          state: 'ok',
          windows: [],
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const snapshot = createUsageSnapshot({
      machine,
      rows: [row('a', 'session-1')],
      datasets: { providerStatus, futureSkills: { preserved: true } },
    });

    const parsed = parseUsageSnapshot(JSON.stringify(snapshot));
    const merged = mergeUsageSnapshots([parsed]);

    expect(parsed.datasets?.futureSkills).toEqual({ preserved: true });
    expect(merged.datasets?.futureSkills).toEqual({ preserved: true });
    expect(merged.datasets?.providerStatus?.providers[0]).toMatchObject({
      key: 'codex',
      machineId: 'machine-1',
      machineLabel: 'Machine 1',
    });
  });

  test('rejects malformed known datasets while retaining JSON-safe future datasets', () => {
    const snapshot = currentSnapshot();
    const cursorCommitAttribution = {
      blankLinesAdded: 0,
      blankLinesDeleted: 0,
      branchName: 'main',
      commitDate: '2026-01-01T00:00:00.000Z',
      commitHash: 'abc123',
      commitMessage: 'Implement snapshot validation',
      composerLinesAdded: 1,
      composerLinesDeleted: 0,
      humanLinesAdded: 0,
      humanLinesDeleted: 0,
      linesAdded: 1,
      linesDeleted: 0,
      scoredAt: '2026-01-01T00:01:00.000Z',
      tabLinesAdded: 0,
      tabLinesDeleted: 0,
      v1AiPercentage: 100,
      v2AiPercentage: null,
    };
    const futureDataset = { schemaVersion: 2, payload: { values: [1, true, null] } };
    const providerStatus = createProviderStatusDataset([
      {
        generatedAt: '2026-01-01T00:00:00.000Z',
        key: 'codex',
        label: 'Codex',
        source: 'local-history',
        state: 'ok',
        windows: [],
      },
    ]);

    const datasets = { cursorCommitAttribution: [cursorCommitAttribution], futureDataset };
    expect(parseUsageSnapshot(JSON.stringify({ ...snapshot, datasets })).datasets).toEqual(datasets);

    const invalidDatasets = [
      null,
      [],
      { cursorCommitAttribution: null },
      { cursorCommitAttribution: [{ commitHash: 'missing-required-fields' }] },
      { cursorCommitAttribution: [{ ...cursorCommitAttribution, linesAdded: -1 }] },
      { cursorCommitAttribution: [{ ...cursorCommitAttribution, commitDate: 'not-a-timestamp' }] },
      { cursorCommitAttribution: [{ ...cursorCommitAttribution, scoredAt: 'not-a-timestamp' }] },
      { cursorCommitAttribution: [{ ...cursorCommitAttribution, v1AiPercentage: 101 }] },
      { cursorCommitAttribution: [{ ...cursorCommitAttribution, unexpected: true }] },
      { providerStatus: { generatedAt: snapshot.generatedAt, providers: [], schemaVersion: 2 } },
      { providerStatus: { ...providerStatus, unexpected: true } },
      {
        providerStatus: {
          ...providerStatus,
          providers: [{ ...providerStatus.providers[0], unexpected: true }],
        },
      },
    ];
    for (const datasets of invalidDatasets) {
      expect(parseSnapshot({ ...snapshot, datasets })).toThrow('datasets');
    }
    expect(() =>
      parseUsageSnapshot(JSON.stringify(snapshot).replace('"rows"', '"datasets":{"future":1e400},"rows"')),
    ).toThrow('datasets');
  });
});
