import {
  parseInstant,
  parseMemoryItemId,
  parseMemoryRevisionId,
  parseProjectId,
} from '@ai-usage/platform-core/identity';
import { distillationInteger, distillationObject } from '@ai-usage/platform-core/session-distillation';
import { type MemoryItemPage, type MemoryKind, type MemorySensitivity, type MemoryTrust, memoryKinds } from './domain';

export interface MemoryItemsBrowseEntry {
  readonly contentOmitted: boolean;
  readonly createdAt: string;
  readonly guidance: readonly string[];
  readonly id: string;
  readonly kind: MemoryKind;
  readonly projectId: string | null;
  readonly provenance: {
    readonly sourceLocator: string | null;
    readonly sourceKind: 'session' | null;
    readonly analysisRevision: number | null;
  };
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly sensitivity: MemorySensitivity;
  readonly summary: string;
  readonly title: string;
  readonly trust: MemoryTrust;
}
export interface MemoryItemsBrowsePage {
  readonly items: readonly MemoryItemsBrowseEntry[];
  readonly nextCursor: string | null;
}
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max) {
    throw new Error('Invalid Memory browse text.');
  }
  return value;
};
/** Explicit compact projection. Exact get retains the complete accepted revision. */
export const projectMemoryItemsBrowsePage = (page: MemoryItemPage): MemoryItemsBrowsePage => ({
  nextCursor: page.nextCursor,
  items: page.items.map(({ item, revision, analysisProvenance: source }) => {
    const sourceLocator = source
      ? `/memory?view=analyses&project=${encodeURIComponent(source.projectId)}&analysis=${encodeURIComponent(source.analysisId)}&element=${encodeURIComponent(source.elementKey)}`
      : null;
    return {
      id: item.id,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      projectId: item.projectId,
      title: revision.title,
      summary: revision.summary.slice(0, 600),
      guidance: revision.guidance.slice(0, 3).map((line) => line.slice(0, 512)),
      kind: item.kind,
      sensitivity: item.sensitivity,
      trust: item.trust,
      createdAt: revision.createdAt,
      contentOmitted:
        revision.structuredContent !== null ||
        revision.summary.length > 600 ||
        revision.guidance.length > 3 ||
        revision.guidance.some((line) => line.length > 512),
      provenance: {
        sourceLocator,
        sourceKind: sourceLocator ? 'session' : null,
        analysisRevision: source?.analysisRevision ?? null,
      },
    };
  }),
});
export const parseMemoryItemsBrowsePage = (value: unknown): MemoryItemsBrowsePage => {
  const page = distillationObject(value);
  if (!Array.isArray(page.items) || page.items.length > 20) {
    throw new Error('Invalid Memory browse page.');
  }
  return {
    nextCursor: page.nextCursor === null ? null : text(page.nextCursor, 4096),
    items: page.items.map((value): MemoryItemsBrowseEntry => {
      const entry = distillationObject(value),
        provenance = distillationObject(entry.provenance);
      if (
        !Array.isArray(entry.guidance) ||
        entry.guidance.length > 3 ||
        !memoryKinds.includes(entry.kind as MemoryKind) ||
        !['normal', 'sensitive'].includes(String(entry.sensitivity)) ||
        !['explicit', 'harvest-accepted'].includes(String(entry.trust)) ||
        typeof entry.contentOmitted !== 'boolean' ||
        (provenance.sourceKind !== null && provenance.sourceKind !== 'session')
      ) {
        throw new Error('Invalid Memory browse entry.');
      }
      return {
        id: parseMemoryItemId(entry.id),
        revisionId: parseMemoryRevisionId(entry.revisionId),
        revisionNumber: distillationInteger(entry.revisionNumber, 1, Number.MAX_SAFE_INTEGER),
        projectId: entry.projectId === null ? null : parseProjectId(entry.projectId),
        title: text(entry.title, 512),
        summary: text(entry.summary, 600),
        guidance: entry.guidance.map((line) => text(line, 512)),
        kind: entry.kind as MemoryKind,
        sensitivity: entry.sensitivity as MemorySensitivity,
        trust: entry.trust as MemoryTrust,
        createdAt: parseInstant(entry.createdAt),
        contentOmitted: entry.contentOmitted,
        provenance: {
          sourceLocator: provenance.sourceLocator === null ? null : text(provenance.sourceLocator, 1024),
          sourceKind: provenance.sourceKind,
          analysisRevision:
            provenance.analysisRevision === null
              ? null
              : distillationInteger(provenance.analysisRevision, 1, Number.MAX_SAFE_INTEGER),
        },
      };
    }),
  };
};
