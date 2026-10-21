import { describe, expect, test } from 'bun:test';
import { isMemoryProposalId, memoryHref, memoryLocation, memoryProjectError } from './memory-url';

const projectId = '0198f179-4837-7000-8000-000000000011';
describe('durable Memory navigation', () => {
  test('opens accepted knowledge by default and retires account addresses without carrying their cursors', () => {
    expect(memoryLocation('/memory')).toEqual({ view: 'knowledge', projectId: null, cursor: null, proposalId: null });
    const legacy = `/memory?view=analyses&project=${projectId}&analysis=saved&analysisProject=other&element=summary&episode=work&q=cache&since=2026-10-06&until=2026-10-07&cursor=old#account`;
    expect(memoryLocation(legacy)).toEqual({ view: 'knowledge', projectId, cursor: null, proposalId: null });
    const next = new URL(memoryHref(legacy, { view: 'review' }), 'http://memory.invalid');
    expect(Object.fromEntries(next.searchParams)).toEqual({ view: 'review', project: projectId });
    expect(next.hash).toBe('');
  });
  test('validates Project scope and preserves it through navigation, clearing and history restoration', () => {
    expect(memoryProjectError(projectId)).toBeNull();
    expect(memoryProjectError(null)).toBeNull();
    expect(memoryProjectError('')).toBeNull();
    for (const invalid of ['invalid', `${projectId}0`, projectId.toUpperCase()]) {
      expect(memoryProjectError(invalid)).toContain('valid Project ID');
    }
    const scoped = memoryHref('/memory', { project: projectId, cursor: null });
    expect(memoryLocation(scoped)).toMatchObject({ view: 'knowledge', projectId });
    expect(memoryLocation(memoryHref(scoped, { view: 'review' }))).toMatchObject({ view: 'review', projectId });
    expect(memoryLocation(memoryHref(scoped, { project: null }))).toMatchObject({ projectId: null });
    expect(memoryLocation(scoped).projectId).toBe(projectId);
  });
  test('addresses one pending proposal in the review queue and leaves the queue by clearing it', () => {
    const proposalId = '0198f179-4837-7000-8000-000000000010';
    expect(memoryLocation(`/memory?view=review&proposal=${proposalId}`)).toMatchObject({
      view: 'review',
      proposalId,
      cursor: null,
    });
    expect(isMemoryProposalId(proposalId)).toBe(true);
    for (const malformed of ['not-a-proposal', proposalId.toUpperCase(), `${proposalId}0`]) {
      expect(isMemoryProposalId(malformed)).toBe(false);
    }
    const queue = memoryHref(`/memory?view=review&proposal=${proposalId}`, { proposal: null, cursor: null });
    expect(memoryLocation(queue)).toMatchObject({ view: 'review', proposalId: null, cursor: null });
  });
});
