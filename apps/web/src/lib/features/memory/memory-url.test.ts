import { describe, expect, test } from 'bun:test';
import { isMemoryProposalId, memoryDateBound, memoryHref, memoryLocation, memoryPeriodError } from './memory-url';

describe('durable Memory navigation', () => {
  test('opens the selected proposal passage without its temporary usage revision', () => {
    expect(
      memoryLocation('/memory?view=analyses&project=known&analysis=saved&element=work%3Adecision%3A2'),
    ).toMatchObject({
      analysisId: 'saved',
      analysisProjectId: 'known',
      episodeId: 'work',
      elementKey: 'work:decision:2',
    });
  });
  test('rejects invalid dates without throwing or silently broadening a corpus', () => {
    for (const date of ['nonsense', '2026-99-01', '2026-02-30', '2026-10-06T00:00:00Z']) {
      expect(memoryDateBound(date)).toBeNull();
      expect(memoryLocation(`/memory?since=${encodeURIComponent(date)}`).periodError).not.toBeNull();
    }
    expect(memoryDateBound('2026-10-06')).toBe('2026-10-06T00:00:00.000Z');
    expect(memoryPeriodError('2026-10-06', '2026-10-01')).not.toBeNull();
  });
  test('keeps library scope separate from an opened account Project', () => {
    const href = memoryHref('/memory?q=cache', { analysis: 'saved', analysisProject: 'one-project' });
    expect(memoryLocation(href)).toMatchObject({ projectId: null, analysisProjectId: 'one-project', query: 'cache' });
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
