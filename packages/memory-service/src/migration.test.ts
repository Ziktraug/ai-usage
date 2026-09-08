import { describe, expect, test } from 'bun:test';
import {
  createMemoryItemId,
  createMemoryObservationId,
  createMemoryRevisionId,
  createPersonId,
  createProjectId,
  createSpaceId,
  parseInstant,
} from '@ai-usage/platform-core/identity';
import type { MemoryExportSnapshot, MemoryKind, MemoryRevision } from './domain';
import { serializeMemoryExport } from './export';
import { type LegacyMemoryStatus, memoryMigrationBounds, parseLegacyMemoryImportSource } from './migration';

const kinds: readonly MemoryKind[] = [
  'decision',
  'pattern',
  'pitfall',
  'command',
  'constraint',
  'handoff',
  'lesson',
  'preference',
];

const legacyMarkdown = (
  kind: MemoryKind,
  index: number,
  status: LegacyMemoryStatus,
  trust: 'explicit' | 'harvest-accepted',
): string => `---
title: "Synthetic ${kind}"
type: ${kind}
scope: ${index % 2 === 0 ? 'global' : 'repo'}
status: ${status}
created: 2026-08-${String(index + 1).padStart(2, '0')}
updated: 2026-08-29
trust: ${trust}
source: "synthetic"
provenance:
  []
tags: [synthetic, ${kind}]
distillation_hash: legacy-${index}
---

# Synthetic ${kind}

## Summary

Summary for ${kind}.

## Guidance for future agents

- Preserve ${kind} semantics.

## Evidence / provenance

None.

## File

synthetic/${kind}.md

## Supersedes

None.

## Superseded by

None.
`;

describe('Memory migration formats', () => {
  test('parses every pinned durable kind with status, trust, and path-independent identity', () => {
    const statuses: readonly LegacyMemoryStatus[] = ['active', 'superseded', 'rejected'];
    const documents = kinds.map((kind, index) => ({
      content: legacyMarkdown(
        kind,
        index,
        statuses[index % statuses.length] ?? 'active',
        index % 2 ? 'explicit' : 'harvest-accepted',
      ),
      sourceLocator: `/synthetic/one/${kind}.md`,
    }));
    const parsed = parseLegacyMemoryImportSource({
      documents,
      sourceKind: 'legacy-markdown',
      sourceLocator: '/synthetic/one',
    });

    expect(parsed.issues).toEqual([]);
    expect(parsed.records.map((record) => record.kind)).toEqual([...kinds]);
    expect(parsed.records.find((record) => record.kind === 'handoff')).toMatchObject({
      kind: 'handoff',
      origin: 'durable',
    });
    expect(new Set(parsed.records.map((record) => record.status))).toEqual(
      new Set<LegacyMemoryStatus>(['active', 'rejected', 'superseded']),
    );
    expect(new Set(parsed.records.map((record) => record.trust))).toEqual(new Set(['explicit', 'harvest-accepted']));

    const sameContentElsewhere = parseLegacyMemoryImportSource({
      documents: [{ content: documents[0]?.content ?? '', sourceLocator: '/different/private/path.md' }],
      sourceKind: 'legacy-markdown',
      sourceLocator: '/different',
    });
    expect(sameContentElsewhere.records[0]?.fingerprint).toBe(parsed.records[0]?.fingerprint);
  });

  test('keeps session harvest as pending evidence and preserves all legacy scopes', () => {
    const content = [
      {
        body: 'Review this session evidence.',
        repo: '/synthetic/repo',
        scope: 'session',
        sensitivity: 'private',
        source: 'recent-work-context',
        timestamp: '2026-08-29T10:00:00.000Z',
        title: 'Session evidence',
        type: 'session-harvest',
        version: '0.1.0',
      },
      {
        body: 'A repository command.',
        repo: '/synthetic/repo',
        scope: 'repo',
        sensitivity: 'sensitive',
        source: 'manual',
        timestamp: '2026-08-29T10:01:00.000Z',
        title: 'Repository command',
        type: 'command',
        version: '0.1.0',
      },
      {
        body: 'A global preference.',
        repo: null,
        scope: 'global',
        sensitivity: 'public',
        source: 'manual',
        timestamp: '2026-08-29T10:02:00.000Z',
        title: 'Global preference',
        type: 'preference',
        version: '0.1.0',
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const parsed = parseLegacyMemoryImportSource({
      documents: [{ content, sourceLocator: 'events.jsonl' }],
      sourceKind: 'legacy-jsonl',
      sourceLocator: 'inbox',
    });

    expect(parsed.issues).toEqual([]);
    expect(parsed.records.map((record) => record.scope)).toEqual(['session', 'repo', 'global']);
    expect(parsed.records[0]).toMatchObject({
      kind: 'handoff',
      origin: 'inbox',
      status: null,
      trust: 'harvest-accepted',
    });
    expect(parsed.records[1]?.sensitivity).toBe('sensitive');
  });

  test('bounds malformed input without accepting a partial oversized document', () => {
    const parsed = parseLegacyMemoryImportSource({
      documents: [{ content: 'x'.repeat(memoryMigrationBounds.maxDocumentBytes + 1), sourceLocator: 'oversized.md' }],
      sourceKind: 'legacy-markdown',
      sourceLocator: 'synthetic',
    });

    expect(parsed.records).toEqual([]);
    expect(parsed.issues).toEqual([{ code: 'document-too-large', documentIndex: 0, recordIndex: null }]);
  });

  test('exports deterministically and reimports current content, identities, and supersession', () => {
    const spaceId = createSpaceId();
    const projectId = createProjectId();
    const personId = createPersonId();
    const firstItemId = createMemoryItemId();
    const secondItemId = createMemoryItemId();
    const firstRevisionId = createMemoryRevisionId();
    const currentRevisionId = createMemoryRevisionId();
    const secondRevisionId = createMemoryRevisionId();
    const principal = { kind: 'person' as const, personId };
    const revision = (
      id: ReturnType<typeof createMemoryRevisionId>,
      itemId: ReturnType<typeof createMemoryItemId>,
      revisionNumber: number,
      title: string,
    ): MemoryRevision => ({
      createdAt: parseInstant(`2026-08-29T10:0${revisionNumber}:00.000Z`),
      createdByPrincipal: principal,
      guidance: [`Guidance ${revisionNumber}`],
      id,
      memoryItemId: itemId,
      reason: revisionNumber === 1 ? null : 'synthetic revision',
      revisionNumber,
      structuredContent: { revisionNumber },
      summary: `Summary ${revisionNumber}`,
      title,
    });
    const snapshot: MemoryExportSnapshot = {
      items: [
        {
          item: {
            currentRevisionId,
            id: firstItemId,
            kind: 'decision',
            owningSpaceId: spaceId,
            projectId,
            scope: 'project',
            sensitivity: 'normal',
            status: 'superseded',
            trust: 'explicit',
          },
          provenance: [
            {
              id: createMemoryObservationId(),
              observedAt: parseInstant('2026-08-29T09:00:00.000Z'),
              sensitivity: 'normal',
              sourceKind: 'file',
              sourceLocator: '/home/operator/private-repository/file.ts',
            },
          ],
          relations: [{ kind: 'supersedes', reason: 'new decision', toMemoryItemId: secondItemId }],
          revisions: [
            revision(firstRevisionId, firstItemId, 1, 'Original decision'),
            revision(currentRevisionId, firstItemId, 2, 'Current decision'),
          ],
        },
        {
          item: {
            currentRevisionId: secondRevisionId,
            id: secondItemId,
            kind: 'handoff',
            owningSpaceId: spaceId,
            projectId: null,
            scope: 'person',
            sensitivity: 'sensitive',
            status: 'archived',
            trust: 'harvest-accepted',
          },
          provenance: [],
          relations: [],
          revisions: [revision(secondRevisionId, secondItemId, 1, 'Legacy handoff')],
        },
      ],
      spaceId,
    };

    for (const format of ['jsonl', 'markdown'] as const) {
      const first = serializeMemoryExport(snapshot, format);
      const second = serializeMemoryExport(snapshot, format);
      expect(second).toEqual(first);
      expect(first.content).not.toContain(personId);
      expect(first.content).not.toContain('/home/operator/private-repository');
      const parsed = parseLegacyMemoryImportSource({
        documents: [{ content: first.content, sourceLocator: `portable.${format}` }],
        sourceKind: format === 'jsonl' ? 'legacy-jsonl' : 'legacy-markdown',
        sourceLocator: 'portable-export',
      });
      expect(parsed.issues).toEqual([]);
      expect(parsed.records).toHaveLength(2);
      expect(parsed.records[0]).toMatchObject({
        kind: 'decision',
        legacyId: firstItemId,
        status: 'superseded',
        supersedes: [secondItemId],
        title: 'Current decision',
        trust: 'explicit',
      });
      expect(parsed.records[1]).toMatchObject({
        kind: 'handoff',
        legacyId: secondItemId,
        scope: 'global',
        status: 'archived',
        trust: 'harvest-accepted',
      });
    }
  });
});
