import { currentRecord, designExportRecords, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'D2' as const;
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
    ]),
  ],
});
