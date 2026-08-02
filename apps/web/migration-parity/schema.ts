export const baselineEvidenceCommit = '2183270ebfbb886fafa7e6268893122db9b364c0';

export const packetIds = [
  'B1',
  'B2',
  'F0',
  'V0',
  'V1',
  'V2',
  'V3',
  'V4',
  'V5',
  'Q0',
  'Q1',
  'Q2',
  'Q3',
  'D0',
  'D1',
  'D2',
  'D3',
  'D4',
  'R0',
  'R1',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'X0',
  'X1',
  'X2',
] as const;

export type PacketId = (typeof packetIds)[number];

export const featureIds = [
  'SHELL-01',
  'SHELL-02',
  'SHELL-03',
  'REPORT-01',
  'REPORT-02',
  'REPORT-03',
  'REPORT-04',
  'REPORT-05',
  'REPORT-06',
  'REPORT-07',
  'FILTER-01',
  'FILTER-02',
  'SESSION-01',
  'SESSION-02',
  'SESSION-03',
  'SESSION-04',
  'SESSION-05',
  'SESSION-06',
  'CAMPAIGN-01',
  'CAMPAIGN-02',
  'QUOTA-01',
  'SKILLS-01',
  'SKILLS-02',
  'SKILLS-03',
  'SKILLS-04',
  'SKILLS-05',
  'SKILLS-06',
  'SOURCES-01',
  'SOURCES-02',
  'SYNC-01',
  'SYNC-02',
  'PRIVACY-01',
  'SECURITY-01',
  'OPS-01',
  'OPS-02',
] as const;

export const designRowIds = [
  'design:preset-global-css',
  'design:semantic-style-exports',
  'design:Toggle',
  'design:HarnessBadge',
  'design:Checkbox',
  'design:Drawer',
  'design:Popover',
  'design:Tooltip',
  'design:MultiSelect',
  'design:SegmentedControl',
  'design:Tabs',
  'design:SegmentBar',
  'design:MetricTile',
  'design:passive-style-modules',
  'design:icons',
] as const;

export const renderSuitePaths = [
  'apps/web/src/dashboard-metrics.render.test.tsx',
  'apps/web/src/drawer-detail-item.render.test.tsx',
  'apps/web/src/group-panel.render.test.tsx',
  'apps/web/src/highlighted-text.render.test.tsx',
  'apps/web/src/overview.render.test.tsx',
  'apps/web/src/project-summary.render.test.tsx',
  'apps/web/src/session-analysis.render.test.tsx',
  'apps/web/src/session-drawer.render.test.tsx',
  'apps/web/src/session-vcs-summary.test.tsx',
  'apps/web/src/skills-detail.render.test.tsx',
  'apps/web/src/sync.render.test.tsx',
] as const;

export const urlContractIds = [
  'url:dashboard.tab',
  'url:dashboard.breakdown-sort',
  'url:dashboard.query',
  'url:dashboard.harness',
  'url:dashboard.machine',
  'url:dashboard.origin',
  'url:dashboard.field-filters',
  'url:dashboard.range',
  'url:dashboard.time-cell',
  'url:dashboard.sort',
  'url:dashboard.columns',
  'url:skills.global-scope',
  'url:skills.global-skill',
  'url:skills.matrix',
  'url:skills.project-scope',
  'url:skills.project-skill',
  'url:session.drawer-identity',
  'url:history.replace-push-back-forward',
] as const;

export const parityKinds = [
  'feature',
  'operation',
  'production-tsx',
  'design-row',
  'design-export',
  'render-suite',
  'playwright-title',
  'url-contract',
] as const;

export const parityStatuses = ['current', 'complete', 'reviewed-removal'] as const;
export const evidenceKinds = ['source', 'test', 'command', 'measurement', 'review'] as const;

export type ParityKind = (typeof parityKinds)[number];
export type ParityStatus = (typeof parityStatuses)[number];
export type EvidenceKind = (typeof evidenceKinds)[number];

export interface ParityEvidence {
  commit: string;
  kind: EvidenceKind;
  reference: string;
}

export interface OperationDescriptor {
  currentMethod: 'GET' | 'POST';
  implementationOwner: string;
  inputParser: string;
  outputParser: string;
  publicErrors: readonly string[];
  target: string;
  transport: 'query' | 'mutation' | 'file';
}

export interface UrlContractDescriptor {
  canonical: string;
  defaultValue: string;
  legacyValues: readonly string[];
  lifecycle: string;
}

export interface ParityRecord {
  currentOwner: string;
  evidence: readonly ParityEvidence[];
  id: string;
  kind: ParityKind;
  operation?: OperationDescriptor;
  replacementReason?: string;
  status: ParityStatus;
  targetOwner: PacketId;
  urlContract?: UrlContractDescriptor;
}

export interface ParityShard {
  owner: PacketId;
  records: readonly ParityRecord[];
}

export const defineParityShard = <const Shard extends ParityShard>(shard: Shard): Shard => shard;

export const waveZeroEvidence = (kind: EvidenceKind, reference: string): ParityEvidence => ({
  commit: baselineEvidenceCommit,
  kind,
  reference,
});
