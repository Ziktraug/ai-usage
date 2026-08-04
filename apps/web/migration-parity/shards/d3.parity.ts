import { currentRecord, designExportRecords, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'D3' as const;
const sourceCommit = 'e2f13cdacb1a9e24ef53b22db0af58334bc19f08';
const unitTestCommit = '0702203efcb773362299220b6b18651d216939e3';
const browserTestCommit = '70f5796e0b9d724c1267e30f2111b6bf66e3be8c';
const d4Commit = '662182e8fba4e55c14aa2d26308adca2f70bf72d';
const cutoverCommit = '75161d96109769a3f315565dfe4cf84ab398a708';
const targetEvidence = (commit: string, kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit,
  kind,
  phase: 'target',
  reference,
});
const publicSvelteExports = new Set(['Tabs']);
const solidOnlyTypeExports = new Set(['TabItem', 'TabsProps']);
const reportRemovalReason = (record: ParityRecord): string => {
  const exportName = record.id.slice(record.id.lastIndexOf('::') + 2);
  if (publicSvelteExports.has(exportName)) {
    return `The Solid ./report export ${exportName} was replaced by the tested D3 public component at ./svelte.`;
  }
  if (solidOnlyTypeExports.has(exportName)) {
    return `The Solid-only ${exportName} contract was intentionally removed; the D3 Svelte compound control owns its typed items and props.`;
  }
  return `The Solid ./report implementation export ${exportName} was internalized by the D3 Svelte compound control or its styles and has no remaining public consumer.`;
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
      'packages/design-system/src/svelte/compound contains the D3 Svelte replacements for the retired Solid compound controls.',
    ),
    targetEvidence(
      unitTestCommit,
      'test',
      'D3 unit proofs cover keyboard, hidden-input, open-state, focus/tabindex, and selection parity.',
    ),
    targetEvidence(
      browserTestCommit,
      'test',
      'D3 browser proofs validate compound-control interaction behavior and cleanup.',
    ),
    targetEvidence(
      cutoverCommit,
      'review',
      '/root/d123_parity_review and /root/x0_final_review ACCEPT the D3 Svelte controls and final consumer closure.',
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
const reviewedRootRemoval = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    targetEvidence(
      sourceCommit,
      'source',
      'packages/design-system/src/svelte/compound contains the D3 Svelte compound-control implementations.',
    ),
    targetEvidence(
      unitTestCommit,
      'test',
      'D3 unit proofs cover keyboard, hidden-input, open-state, focus/tabindex, and selection parity.',
    ),
    targetEvidence(
      browserTestCommit,
      'test',
      'D3 browser-proof hardening validates compound-control interaction behavior.',
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
    designRow('design:MultiSelect', 'packages/design-system/src/components/select.tsx'),
    designRow('design:SegmentedControl', 'packages/design-system/src/components/segmented-control.tsx'),
    designRow('design:Tabs', 'packages/design-system/src/components/tabs.tsx'),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'packages/design-system/src/components/segmented-control.tsx',
      'packages/design-system/src/components/select.tsx',
      'packages/design-system/src/components/tabs.tsx',
    ]),
    ...designExportRecords(owner, [
      {
        entrypoint: '.',
        names: ['MultiSelect', 'MultiSelectProps'],
        source: 'packages/design-system/src/components/select.tsx',
      },
      {
        entrypoint: '.',
        names: ['SegmentedControl', 'SegmentedControlItem', 'SegmentedControlProps'],
        source: 'packages/design-system/src/components/segmented-control.tsx',
      },
      {
        entrypoint: '.',
        names: ['TabItem', 'Tabs', 'TabsProps'],
        source: 'packages/design-system/src/components/tabs.tsx',
      },
      {
        entrypoint: './report',
        names: ['TabItem', 'Tabs', 'TabsProps', 'tabContent', 'tabTrigger', 'tabsList', 'tabsRoot'],
        source: 'packages/design-system/src/components/tabs.tsx',
      },
    ]).map((record) => (record.id.startsWith('design-export:.::') ? reviewedRootRemoval(record) : record)),
  ].map(closeAtCutover),
});
