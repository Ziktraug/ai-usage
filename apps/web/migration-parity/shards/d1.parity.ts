import { currentRecord, designExportRecords, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'D1' as const;
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
    ]),
  ],
});
