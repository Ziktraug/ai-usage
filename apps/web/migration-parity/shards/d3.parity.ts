import { currentRecord, designExportRecords, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'D3' as const;
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
    ]),
  ],
});
