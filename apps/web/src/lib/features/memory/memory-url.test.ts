import { describe, expect, test } from 'bun:test';
import { reportDestinationUrl } from '../shell/navigation';
import {
  isMemoryProposalId,
  memoryCanonicalRedirect,
  memoryHref,
  memoryLocation,
  memoryProjectError,
} from './memory-url';

const projectId = '0198f179-4837-7000-8000-000000000011';
describe('durable Memory navigation', () => {
  test('canonicalizes retired Memory state once while retaining Project and unrelated report filters', () => {
    const legacy = `/memory?view=analyses&project=${projectId}&analysis=saved&analysisProject=other&element=summary&episode=work&cursor=old&proposal=old&q=cache&range=all&machine=%5B%22m1%22%5D&foreign=kept`;
    const redirect = memoryCanonicalRedirect(legacy);
    expect(redirect).not.toBeNull();
    const canonical = new URL(redirect!, 'http://memory.invalid');
    expect(Object.fromEntries(canonical.searchParams)).toEqual({
      view: 'knowledge',
      project: projectId,
      q: 'cache',
      range: 'all',
      machine: '["m1"]',
      foreign: 'kept',
    });
    expect(memoryCanonicalRedirect(canonical.href)).toBeNull();
    const report = reportDestinationUrl(canonical, 'sessions');
    expect(report.searchParams.has('analysis')).toBe(false);
    expect(report.searchParams.get('q')).toBe('cache');
    expect(report.searchParams.get('machine')).toBe('["m1"]');
    expect(report.searchParams.get('foreign')).toBe('kept');
  });

  test('preserves valid review addressing and existing malformed-identity validation', () => {
    for (const address of [
      '/memory',
      `/memory?view=knowledge&project=${projectId}`,
      `/memory?view=review&project=${projectId}&cursor=next-page&proposal=${projectId}`,
      '/memory?view=review&project=invalid&proposal=invalid&cursor=current',
      '/memory?view=knowledge&q=report%20filter&foreign=kept',
    ]) {
      expect(memoryCanonicalRedirect(address)).toBeNull();
    }
    const review = `/memory?view=review&project=${projectId}&cursor=current&proposal=invalid`;
    expect(memoryCanonicalRedirect(`${review}&analysis=retired`)).toBe(review);
  });

  test('normalizes unknown views to Knowledge and removes review positioning outside Review', () => {
    expect(memoryCanonicalRedirect('/memory?view=unknown&cursor=old&proposal=old&foreign=kept')).toBe(
      '/memory?view=knowledge&foreign=kept',
    );
    expect(memoryCanonicalRedirect('/memory?cursor=old')).toBe('/memory');
    expect(memoryCanonicalRedirect('/memory?view=knowledge&proposal=old')).toBe('/memory?view=knowledge');
    expect(memoryCanonicalRedirect('/memory?view=review&view=analyses&cursor=current')).toBe(
      '/memory?view=review&cursor=current',
    );
  });
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
