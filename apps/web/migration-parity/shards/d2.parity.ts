import { currentRecord, designExportRecords, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'D2' as const;
const sourceCommit = 'fce5c1aa718e444573ffc304bb24141cc975b759';
const testCommit = '9935846b745a2702fe953cb16259b7fe0fd22278';
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
      'packages/design-system/src/svelte/overlays contains the D2 Svelte overlay implementations.',
    ),
    targetEvidence(
      testCommit,
      'test',
      'D2 unit and browser proofs cover portals, focus, Escape, outside interaction, lazy mount, and cleanup parity.',
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
    evidence: [{ kind: 'source', reference: currentOwner }],
    id,
    kind: 'design-row',
  });

export default defineParityShard({
  owner,
  records: [
    designRow('design:Drawer', 'packages/design-system/src/components/drawer.tsx'),
    designRow('design:Popover', 'packages/design-system/src/components/popover.tsx'),
    designRow('design:Tooltip', 'packages/design-system/src/components/tooltip.tsx'),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'packages/design-system/src/components/drawer.tsx',
      'packages/design-system/src/components/popover.tsx',
      'packages/design-system/src/components/tooltip.tsx',
    ]),
    ...designExportRecords(owner, [
      {
        entrypoint: '.',
        names: ['Drawer', 'DrawerProps'],
        source: 'packages/design-system/src/components/drawer.tsx',
      },
      {
        entrypoint: '.',
        names: ['Popover', 'PopoverProps'],
        source: 'packages/design-system/src/components/popover.tsx',
      },
      {
        entrypoint: '.',
        names: ['Tooltip', 'TooltipProps'],
        source: 'packages/design-system/src/components/tooltip.tsx',
      },
      {
        entrypoint: './report',
        names: [
          'Drawer',
          'DrawerProps',
          'drawer',
          'drawerActions',
          'drawerBody',
          'drawerCompare',
          'drawerGrid',
          'drawerLegend',
          'drawerLegendItem',
          'drawerLegendSwatch',
          'drawerLegendValue',
          'drawerNav',
          'drawerPosition',
          'drawerTitle',
          'drawerTop',
        ],
        source: 'packages/design-system/src/components/drawer.tsx',
      },
      {
        entrypoint: './report',
        names: ['Popover', 'PopoverProps', 'popoverContent', 'popoverGrid', 'popoverHeader'],
        source: 'packages/design-system/src/components/popover.tsx',
      },
      {
        entrypoint: './report',
        names: [
          'CellWithProvenance',
          'ProvenanceMarker',
          'ProvenanceMarkerFact',
          'Tooltip',
          'TooltipProps',
          'provenanceMarkerGlyph',
          'tooltipContent',
        ],
        source: 'packages/design-system/src/components/tooltip.tsx',
      },
    ]).map((record) => (record.id.startsWith('design-export:.::') ? reviewedRootRemoval(record) : record)),
  ].map(closeAtCutover),
});
