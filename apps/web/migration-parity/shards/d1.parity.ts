import { currentRecord, designExportRecords, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'D1' as const;
const sourceCommit = '4862293401157c5765f94b8afe1424f4ade3ecfa';
const testCommit = '3b22c28accd448374a1ed94701e7041ddcc2da10';
const d4Commit = '662182e8fba4e55c14aa2d26308adca2f70bf72d';
const cutoverCommit = '75161d96109769a3f315565dfe4cf84ab398a708';
const targetEvidence = (commit: string, kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit,
  kind,
  phase: 'target',
  reference,
});
const publicSvelteExports = new Set(['BarSegment', 'Checkbox', 'HarnessBadge', 'MetricTile', 'SegmentBar']);
const solidOnlyTypeExports = new Set(['CheckboxProps', 'MetricTileProps']);
const reportRemovalReason = (record: ParityRecord): string => {
  const exportName = record.id.slice(record.id.lastIndexOf('::') + 2);
  if (publicSvelteExports.has(exportName)) {
    return `The Solid ./report export ${exportName} was replaced by the tested D1 public component or type at ./svelte.`;
  }
  if (solidOnlyTypeExports.has(exportName)) {
    return `The Solid-only ${exportName} contract was intentionally removed; the D1 Svelte component owns its typed props.`;
  }
  return `The Solid ./report implementation export ${exportName} was internalized by the D1 Svelte control or its passive styles and has no remaining public consumer.`;
};
const closeAtCutover = (record: ParityRecord): ParityRecord => {
  if (record.status !== 'current') {
    return record;
  }

  const evidence = [
    ...record.evidence,
    targetEvidence(
      sourceCommit,
      'source',
      'packages/design-system/src/svelte/controls contains the D1 Svelte replacements for the retired Solid controls.',
    ),
    targetEvidence(
      testCommit,
      'test',
      'D1 unit and browser proofs cover controlled state, propagation, semantics, accessibility, and render parity.',
    ),
    targetEvidence(
      cutoverCommit,
      'review',
      '/root/d123_parity_review and /root/x0_final_review ACCEPT the D1 Svelte controls and final consumer closure.',
    ),
  ];
  if (record.kind === 'design-export') {
    return {
      ...record,
      evidence,
      replacementReason: reportRemovalReason(record),
      status: 'reviewed-removal',
    };
  }

  return { ...record, evidence, status: 'complete' };
};
const breakdownRepairCommit = '2eee573caaa4cd6f38ec67c34797e56bb614e1c6';
const breakdownBarExportIds = new Set(['design-export:./report::barFill', 'design-export:./report::barTrack']);
const restoreBreakdownBarExport = (record: ParityRecord): ParityRecord => {
  if (!breakdownBarExportIds.has(record.id)) {
    return record;
  }

  const restoredRecord = { ...record, replacementReason: undefined };
  return {
    ...restoredRecord,
    currentOwner: 'packages/design-system/src/components/segment-bar.ts',
    evidence: [
      ...record.evidence,
      targetEvidence(
        breakdownRepairCommit,
        'command',
        'bun run --cwd apps/web typecheck; bun test apps/web/src/lib/features/report/breakdown packages/design-system/src/design-entrypoints.test.ts; bun run --cwd apps/web test:e2e -- e2e/value-presentation.spec.ts; bun tools/check-design-export-consumers.ts (green)',
      ),
      targetEvidence(
        breakdownRepairCommit,
        'measurement',
        'Hydrated Solid 2183270e differential at 361/768/1024/1440 in light/dark: the restored 6px bar track and rounded semantic fill match at all eight points.',
      ),
      targetEvidence(
        breakdownRepairCommit,
        'review',
        'Presentation-parity review confirmed barTrack and barFill are live shared semantic exports again, with Svelte consumers in BreakdownRow and HarnessProviderPanel.',
      ),
    ],
    status: 'complete',
  };
};
const reviewedRootRemoval = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    targetEvidence(
      sourceCommit,
      'source',
      'packages/design-system/src/svelte/controls contains the D1 Svelte control implementations.',
    ),
    targetEvidence(
      testCommit,
      'test',
      'D1 control unit and browser proofs cover controlled state, propagation, semantics, accessibility, and render parity.',
    ),
    targetEvidence(
      d4Commit,
      'source',
      'packages/design-system/src/index.ts is framework-neutral; explicit compatibility and Svelte targets are exported from ./solid and ./svelte.',
    ),
    targetEvidence(
      d4Commit,
      'review',
      '/root/d4_review ACCEPT covers the explicit framework entrypoints, neutral package root, and dependency closure.',
    ),
  ],
  replacementReason:
    'D4 intentionally removed framework components from the neutral package root; callers use the explicit ./solid or ./svelte entrypoint.',
  status: 'reviewed-removal',
});
const designRow = (id: string, currentOwner: string) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [{ kind: 'test', reference: `${currentOwner}; packages/design-system/src/preset.test.ts` }],
    id,
    kind: 'design-row',
  });

export default defineParityShard({
  owner,
  records: [
    designRow('design:Toggle', 'packages/design-system/src/components/toggle.tsx'),
    designRow('design:HarnessBadge', 'packages/design-system/src/components/badge.tsx'),
    designRow('design:Checkbox', 'packages/design-system/src/components/checkbox.tsx'),
    designRow('design:SegmentBar', 'packages/design-system/src/components/segment-bar.tsx'),
    designRow('design:MetricTile', 'packages/design-system/src/components/metric-tile.tsx'),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'packages/design-system/src/components/badge.tsx',
      'packages/design-system/src/components/checkbox.tsx',
      'packages/design-system/src/components/metric-tile.tsx',
      'packages/design-system/src/components/segment-bar.tsx',
      'packages/design-system/src/components/toggle.tsx',
    ]),
    ...designExportRecords(owner, [
      {
        entrypoint: '.',
        names: ['HarnessBadge'],
        source: 'packages/design-system/src/components/badge.tsx',
      },
      {
        entrypoint: '.',
        names: ['Checkbox', 'CheckboxProps'],
        source: 'packages/design-system/src/components/checkbox.tsx',
      },
      {
        entrypoint: '.',
        names: ['MetricTile', 'MetricTileProps'],
        source: 'packages/design-system/src/components/metric-tile.tsx',
      },
      {
        entrypoint: '.',
        names: ['BarSegment', 'SegmentBar'],
        source: 'packages/design-system/src/components/segment-bar.tsx',
      },
      {
        entrypoint: '.',
        names: ['Toggle', 'ToggleProps'],
        source: 'packages/design-system/src/components/toggle.tsx',
      },
      {
        entrypoint: './report',
        names: ['HarnessBadge', 'badgeToneFor', 'harnessFamily', 'harnessFillFor', 'harnessSvgFillFor'],
        source: 'packages/design-system/src/components/badge.tsx',
      },
      {
        entrypoint: './report',
        names: ['Checkbox', 'CheckboxProps', 'columnToggle', 'columnToggleInput', 'columnToggleText'],
        source: 'packages/design-system/src/components/checkbox.tsx',
      },
      {
        entrypoint: './report',
        names: [
          'MetricTile',
          'MetricTileProps',
          'metricDelta',
          'metricDeltaArrow',
          'metricGrid',
          'metricLabel',
          'metricTile',
          'metricValue',
        ],
        source: 'packages/design-system/src/components/metric-tile.tsx',
      },
      {
        entrypoint: './report',
        names: [
          // `accentFill` is no longer a removal: the Activity chart needs a
          // neutral series fill again, so it lives in the chart module and is
          // recorded as a live export in the X1 shard.
          'BarSegment',
          'SegmentBar',
          'barFill',
          'barTrack',
          'inkFill',
          'segmentBarPart',
          'segmentBarTrack',
          'tokenSegmentClasses',
        ],
        source: 'packages/design-system/src/components/segment-bar.tsx',
      },
    ]).map((record) => (record.id.startsWith('design-export:.::') ? reviewedRootRemoval(record) : record)),
  ]
    .map(closeAtCutover)
    .map(restoreBreakdownBarExport),
});
