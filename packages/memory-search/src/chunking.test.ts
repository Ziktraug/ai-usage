import { describe, expect, test } from 'bun:test';
import {
  parseInstant,
  parseMemoryItemId,
  parseMemoryRevisionId,
  parsePersonId,
  parseSpaceId,
} from '@ai-usage/platform-core/identity';
import { createMemorySearchChunks, memorySearchStructuredText } from './chunking';

const itemId = parseMemoryItemId('019d0000-0000-7000-8000-000000000003');
const revisionId = parseMemoryRevisionId('019d0000-0000-7000-8000-000000000004');

describe('Memory search chunking', () => {
  test('is deterministic and preserves sorted structured terms and command punctuation', () => {
    const item = {
      currentRevisionId: revisionId,
      id: itemId,
      kind: 'command' as const,
      owningSpaceId: parseSpaceId('019d0000-0000-7000-8000-000000000001'),
      projectId: null,
      scope: 'space' as const,
      sensitivity: 'normal' as const,
      status: 'active' as const,
      trust: 'explicit' as const,
    };
    const revision = {
      createdAt: parseInstant('2026-08-30T10:00:00.000Z'),
      createdByPrincipal: {
        kind: 'person' as const,
        personId: parsePersonId('019d0000-0000-7000-8000-000000000005'),
      },
      guidance: ["direnv exec . bash -lc 'pnpm check'"],
      id: revisionId,
      memoryItemId: itemId,
      reason: null,
      revisionNumber: 1,
      structuredContent: { z: 'last', a: { command: 'pnpm --filter ./apps/web check' } },
      summary: 'Exact command fixture.',
      title: 'pnpm check',
    };

    const first = createMemorySearchChunks(item, revision);
    const second = createMemorySearchChunks(item, revision);
    expect(first).toEqual(second);
    expect(first[0]?.guidance).toContain("bash -lc 'pnpm check'");
    expect(memorySearchStructuredText(revision.structuredContent)).toBe(
      'a.command: pnpm --filter ./apps/web check\nz: last',
    );
  });

  test('creates bounded deterministic chunks for long accepted content', () => {
    const item = {
      currentRevisionId: revisionId,
      id: itemId,
      kind: 'lesson' as const,
      owningSpaceId: parseSpaceId('019d0000-0000-7000-8000-000000000001'),
      projectId: null,
      scope: 'space' as const,
      sensitivity: 'normal' as const,
      status: 'active' as const,
      trust: 'explicit' as const,
    };
    const chunks = createMemorySearchChunks(item, {
      createdAt: parseInstant('2026-08-30T10:00:00.000Z'),
      createdByPrincipal: { id: 'synthetic', kind: 'service' },
      guidance: ['g'.repeat(5000)],
      id: revisionId,
      memoryItemId: itemId,
      reason: null,
      revisionNumber: 1,
      structuredContent: { detail: 'd'.repeat(5000) },
      summary: 's'.repeat(5000),
      title: 'Long fixture',
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.supportingText.length <= 2048)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.chunkId)).size).toBe(chunks.length);
  });
});
