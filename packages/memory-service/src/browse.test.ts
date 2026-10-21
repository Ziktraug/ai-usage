import { expect, test } from 'bun:test';
import {
  createMemoryItemId,
  createMemoryRevisionId,
  createPersonId,
  createProjectId,
  createSpaceId,
  instantNow,
} from '@ai-usage/platform-core/identity';
import { parseMemoryItemsBrowsePage, projectMemoryItemsBrowsePage } from './browse';
import type { MemoryItemPage } from './domain';

test('retains historical account provenance as text and preserves accepted knowledge', () => {
  const itemId = createMemoryItemId();
  const revisionId = createMemoryRevisionId();
  const projectId = createProjectId();
  const source: MemoryItemPage = {
    nextCursor: null,
    items: [
      {
        item: {
          id: itemId,
          currentRevisionId: revisionId,
          kind: 'constraint',
          owningSpaceId: createSpaceId(),
          projectId,
          scope: 'project',
          sensitivity: 'normal',
          status: 'active',
          trust: 'harvest-accepted',
        },
        revision: {
          id: revisionId,
          memoryItemId: itemId,
          createdAt: instantNow(() => new Date('2026-10-01T00:00:00.000Z')),
          createdByPrincipal: { kind: 'person', personId: createPersonId() },
          guidance: ['Preserve existing accepted guidance.'],
          reason: null,
          revisionNumber: 2,
          structuredContent: { evidence: 'retained' },
          summary: 'Accepted knowledge survives retirement.',
          title: 'Keep accepted knowledge',
        },
        analysisProvenance: {
          analysisId: 'historical-account',
          analysisRevision: 3,
          elementKey: 'decision:1',
          projectId,
        },
      },
    ],
  };

  const projected = parseMemoryItemsBrowsePage(projectMemoryItemsBrowsePage(source));
  expect(projected.items[0]).toMatchObject({
    id: itemId,
    revisionId,
    title: 'Keep accepted knowledge',
    guidance: ['Preserve existing accepted guidance.'],
    provenance: {
      sourceLocator: 'Session account historical-account, element decision:1',
      sourceKind: 'session',
      analysisRevision: 3,
    },
  });
  expect(JSON.stringify(projected)).not.toContain('/memory?');
  expect(source.items[0]?.analysisProvenance).toEqual({
    analysisId: 'historical-account',
    analysisRevision: 3,
    elementKey: 'decision:1',
    projectId,
  });
});
