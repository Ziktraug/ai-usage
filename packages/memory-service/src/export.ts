import { createHash } from 'node:crypto';
import type { MemoryExportSnapshot, MemoryJsonValue, MemoryRevision } from './domain';
import { type MemoryExportArtifact, type MemoryExportFormat, memoryMigrationBounds } from './migration';

const encoder = new TextEncoder();
const maxExportBytes = memoryMigrationBounds.maxSourceBytes;
const markdownItemBoundary = '\n<!-- ai-usage-memory-item-boundary -->\n';

const escapeYamlString = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

const bulletList = (items: readonly string[]): string =>
  items.length === 0 ? 'None.' : items.map((item) => `- ${item}`).join('\n');

const exportRevision = (revision: MemoryRevision) => ({
  createdAt: revision.createdAt,
  createdByKind: revision.createdByPrincipal.kind,
  guidance: revision.guidance,
  id: revision.id,
  reason: revision.reason,
  revisionNumber: revision.revisionNumber,
  structuredContent: revision.structuredContent,
  summary: revision.summary,
  title: revision.title,
});

const portableProvenance = (snapshot: MemoryExportSnapshot['items'][number]) =>
  snapshot.provenance.map((source) => ({
    id: source.id,
    observedAt: source.observedAt,
    sensitivity: source.sensitivity,
    sourceKind: source.sourceKind,
  }));

const exportJsonl = (snapshot: MemoryExportSnapshot): string =>
  snapshot.items
    .map((entry) =>
      JSON.stringify({
        item: {
          currentRevisionId: entry.item.currentRevisionId,
          id: entry.item.id,
          kind: entry.item.kind,
          projectId: entry.item.projectId,
          scope: entry.item.scope,
          sensitivity: entry.item.sensitivity,
          status: entry.item.status,
          trust: entry.item.trust,
        },
        provenance: portableProvenance(entry),
        relations: entry.relations,
        revisions: entry.revisions.map(exportRevision),
        schemaVersion: 1,
        spaceId: snapshot.spaceId,
      }),
    )
    .join('\n') + (snapshot.items.length > 0 ? '\n' : '');

const renderRevisionHistory = (revisions: readonly MemoryRevision[]): string =>
  revisions
    .map(
      (revision) =>
        `- revision ${revision.revisionNumber}: ${revision.id} at ${revision.createdAt}` +
        (revision.reason ? ` — ${revision.reason}` : ''),
    )
    .join('\n');

const exportMarkdown = (snapshot: MemoryExportSnapshot): string =>
  snapshot.items
    .map((entry) => {
      const { item, relations, revisions } = entry;
      const current = revisions.find((revision) => revision.id === item.currentRevisionId);
      if (!current) {
        throw new Error('Memory export current revision is unavailable.');
      }
      const created = revisions[0]?.createdAt ?? current.createdAt;
      const provenance = portableProvenance(entry).map(
        (source) => `${source.sourceKind}:${source.id}:${source.observedAt}`,
      );
      const supersedes = relations
        .filter((relation) => relation.kind === 'supersedes')
        .map((relation) => relation.toMemoryItemId);
      return `---
title: "${escapeYamlString(current.title)}"
type: ${item.kind}
scope: ${item.scope === 'project' ? 'repo' : 'global'}
status: ${item.status}
created: ${created}
updated: ${current.createdAt}
trust: ${item.trust}
sensitivity: ${item.sensitivity}
memory_item_id: ${item.id}
current_revision_id: ${item.currentRevisionId}
project_id: ${item.projectId ?? 'null'}
provenance:
${provenance.length > 0 ? provenance.map((source) => `  - "${escapeYamlString(source)}"`).join('\n') : '  []'}
tags: [db-native-export]
distillation_hash: ${createHash('sha256').update(item.id).digest('hex').slice(0, 12)}
---

# ${current.title}

## Summary

${current.summary}

## Guidance for future agents

${bulletList(current.guidance)}

## Evidence / provenance

${bulletList(provenance)}

## Structured content

\`\`\`json
${JSON.stringify(current.structuredContent, null, 2)}
\`\`\`

## Revision history

${renderRevisionHistory(revisions)}

## Supersedes

${bulletList(supersedes)}

## Superseded by

None.
`;
    })
    .join(markdownItemBoundary);

export const serializeMemoryExport = (
  snapshot: MemoryExportSnapshot,
  format: MemoryExportFormat,
): MemoryExportArtifact => {
  const content = format === 'jsonl' ? exportJsonl(snapshot) : exportMarkdown(snapshot);
  if (encoder.encode(content).byteLength > maxExportBytes) {
    throw new Error('Memory export exceeds its byte limit.');
  }
  return {
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    format,
    itemCount: snapshot.items.length,
    revisionCount: snapshot.items.reduce((total, item) => total + item.revisions.length, 0),
  };
};

export const memoryExportJsonValue = (artifact: MemoryExportArtifact): MemoryJsonValue => ({
  contentHash: artifact.contentHash,
  format: artifact.format,
  itemCount: artifact.itemCount,
  revisionCount: artifact.revisionCount,
});
