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
const closeAtCutover = (record: ParityRecord): ParityRecord => {
  if (record.status !== 'current') {
    return record;
  }

  const evidence = [
    ...record.evidence,
    targetEvidence(
      cutoverCommit,
      'test',
      'Canonical SvelteKit consumers preserve the design row or replace the retired Solid production owner.',
    ),
    targetEvidence(
      cutoverCommit,
      'review',
      'Independent D1-D4 packet reviews and /root/x0_final_review ACCEPT the final design-system closure.',
    ),
  ];
  if (record.kind === 'design-export') {
    return {
      ...record,
      evidence,
      replacementReason:
        'The Solid component/report export was intentionally retired; the tested Svelte component surface is exposed from ./svelte and retained passive styles remain explicit report exports.',
      status: 'reviewed-removal',
    };
  }

  return { ...record, evidence, status: 'complete' };
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
          'BarSegment',
          'SegmentBar',
          'accentFill',
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
  ].map(closeAtCutover),
});
