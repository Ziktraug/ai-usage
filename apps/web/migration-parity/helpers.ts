import {
  type EvidenceKind,
  type OperationDescriptor,
  type PacketId,
  type ParityKind,
  type ParityRecord,
  type UrlContractDescriptor,
  waveZeroEvidence,
} from './schema';

const whitespacePattern = /\s+/u;
export interface CurrentRecordSpec {
  currentOwner: string;
  evidence?: readonly { kind: EvidenceKind; reference: string }[];
  id: string;
  kind: ParityKind;
  operation?: OperationDescriptor;
  urlContract?: UrlContractDescriptor;
}

export const currentRecord = (targetOwner: PacketId, spec: CurrentRecordSpec): ParityRecord => ({
  currentOwner: spec.currentOwner,
  evidence: (spec.evidence ?? [{ kind: 'source', reference: spec.currentOwner }]).map(({ kind, reference }) =>
    waveZeroEvidence(kind, reference),
  ),
  id: spec.id,
  kind: spec.kind,
  ...(spec.operation === undefined ? {} : { operation: spec.operation }),
  status: 'current',
  targetOwner,
  ...(spec.urlContract === undefined ? {} : { urlContract: spec.urlContract }),
});

export const sourceInventoryRecords = (
  targetOwner: PacketId,
  kind: 'production-tsx' | 'render-suite',
  paths: readonly string[],
): readonly ParityRecord[] =>
  paths.map((sourcePath) =>
    currentRecord(targetOwner, {
      currentOwner: sourcePath,
      id: `${kind === 'production-tsx' ? 'tsx' : 'render'}:${sourcePath}`,
      kind,
      evidence: [{ kind: kind === 'render-suite' ? 'test' : 'source', reference: sourcePath }],
    }),
  );

export interface DesignExportGroup {
  entrypoint: string;
  names: readonly string[] | string;
  source: string;
}

const expandDesignExportNames = (names: readonly string[] | string): readonly string[] =>
  typeof names === 'string' ? names.trim().split(whitespacePattern) : names;

export const designExportRecords = (
  targetOwner: PacketId,
  groups: readonly DesignExportGroup[],
): readonly ParityRecord[] =>
  groups.flatMap(({ entrypoint, names, source }) =>
    expandDesignExportNames(names).map((name) =>
      currentRecord(targetOwner, {
        currentOwner: source,
        evidence: [{ kind: 'source', reference: `${source} exports ${name}` }],
        id: `design-export:${entrypoint}::${name}`,
        kind: 'design-export',
      }),
    ),
  );

export interface PlaywrightTitle {
  file: string;
  title: string;
}

export const playwrightTitleRecords = (
  targetOwner: PacketId,
  titles: readonly PlaywrightTitle[],
): readonly ParityRecord[] =>
  titles.map(({ file, title }) =>
    currentRecord(targetOwner, {
      currentOwner: file,
      evidence: [{ kind: 'test', reference: `${file} › ${title}` }],
      id: `pw:${file}::${title}`,
      kind: 'playwright-title',
    }),
  );
