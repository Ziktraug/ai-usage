import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  sessionCampaignChildrenRequestSchema,
  sessionContract,
  sessionDetailRequestSchema,
  sessionDetailResponseSchema,
  sessionNeighborRequestSchema,
  sessionPageOutputSchema,
  sessionQueryRequestSchema,
  sessionVcsResolveRequestSchema,
  sessionVcsResolveResponseSchema,
} from './session';

const queryRequest = {
  cursor: null,
  filters: {
    fields: {},
    harness: ['codex', 'claude', 'codex'],
    machine: [],
    query: '  SEARCH  ',
  },
  pageSize: 25,
  range: { from: null, to: null },
  revision: 'revision-1',
  sort: [{ desc: true, id: 'date' }],
} as const;

describe('Session contract', () => {
  test('defines five POST query procedures with their exact closed public error families', () => {
    expect(Object.keys(sessionContract).sort()).toEqual(['campaignChildren', 'detail', 'neighbors', 'page', 'vcs']);
    expect(sessionContract.page['~orpc'].route).toEqual({ method: 'POST', path: '/session/page' });
    expect(sessionContract.campaignChildren['~orpc'].route).toEqual({
      method: 'POST',
      path: '/session/campaign-children',
    });
    expect(sessionContract.neighbors['~orpc'].route).toEqual({ method: 'POST', path: '/session/neighbors' });
    expect(sessionContract.detail['~orpc'].route).toEqual({ method: 'POST', path: '/session/detail' });
    expect(sessionContract.vcs['~orpc'].route).toEqual({ method: 'POST', path: '/session/vcs' });

    const exactErrors = ['ForbiddenDemo', 'IncompatibleStore', 'InvalidInput', 'RevisionExpired'];
    const localErrors = ['Forbidden', 'ForbiddenDemo', 'InvalidInput', 'Unavailable'];
    expect(Object.keys(sessionContract.page['~orpc'].errorMap).sort()).toEqual(exactErrors);
    expect(Object.keys(sessionContract.campaignChildren['~orpc'].errorMap).sort()).toEqual(exactErrors);
    expect(Object.keys(sessionContract.neighbors['~orpc'].errorMap).sort()).toEqual(exactErrors);
    expect(Object.keys(sessionContract.detail['~orpc'].errorMap).sort()).toEqual(localErrors);
    expect(Object.keys(sessionContract.vcs['~orpc'].errorMap).sort()).toEqual(localErrors);
  });

  test('preserves canonical page input parsing and rejects unknown or invalid fields', () => {
    const parsed = safeParse(sessionQueryRequestSchema, queryRequest);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.filters.harness).toEqual(['claude', 'codex']);
      expect(parsed.output.filters.origin).toEqual([]);
      expect(parsed.output.filters.query).toBe('search');
    }

    expect(
      safeParse(sessionQueryRequestSchema, { ...queryRequest, privatePath: '/private/store.sqlite' }).success,
    ).toBe(false);
    expect(safeParse(sessionQueryRequestSchema, { ...queryRequest, pageSize: 0 }).success).toBe(false);
    expect(
      safeParse(sessionQueryRequestSchema, {
        ...queryRequest,
        revision: ' revision-1 ',
      }).success,
    ).toBe(false);
  });

  test('validates campaign, neighbor, detail, and VCS request identities exactly', () => {
    expect(
      safeParse(sessionCampaignChildrenRequestSchema, {
        campaignKey: 'campaign-1',
        query: queryRequest,
      }).success,
    ).toBe(true);
    expect(
      safeParse(sessionCampaignChildrenRequestSchema, {
        campaignKey: 'campaign-1',
        extra: true,
        query: queryRequest,
      }).success,
    ).toBe(false);
    expect(safeParse(sessionNeighborRequestSchema, { query: queryRequest, rowId: 'row-1' }).success).toBe(true);
    expect(
      safeParse(sessionNeighborRequestSchema, {
        query: queryRequest,
        rowId: '',
      }).success,
    ).toBe(false);
    expect(safeParse(sessionDetailRequestSchema, { revision: 'revision-1', rowId: 'row-1' }).success).toBe(true);
    expect(
      safeParse(sessionDetailRequestSchema, {
        revision: 'revision-1',
        rowId: 'row-1',
        token: 'secret',
      }).success,
    ).toBe(false);
    expect(safeParse(sessionVcsResolveRequestSchema, { revision: 'revision-1', rowId: 'row-1' }).success).toBe(true);
    expect(
      safeParse(sessionVcsResolveRequestSchema, {
        revision: 'revision-1',
        rowId: 'row-1',
        repositoryPath: '/private/repository',
      }).success,
    ).toBe(false);
  });

  test('keeps exact-query envelopes JSON-only and validates detail/VCS outputs deeply', () => {
    expect(
      safeParse(sessionPageOutputSchema, {
        data: {
          itemCount: 0,
          items: [],
          nextCursor: null,
          requestFingerprint: 'fingerprint',
          revision: 'revision-1',
          sessionCount: 0,
        },
        ok: true,
        requestFingerprint: 'fingerprint',
        revision: 'revision-1',
      }).success,
    ).toBe(true);
    expect(
      safeParse(sessionPageOutputSchema, {
        data: new Date(),
        ok: true,
        requestFingerprint: 'fingerprint',
        revision: 'revision-1',
      }).success,
    ).toBe(false);

    expect(
      safeParse(sessionPageOutputSchema, {
        data: {
          itemCount: 0,
          items: [],
          nextCursor: null,
          requestFingerprint: 'fingerprint',
          revision: 'revision-1',
          sessionCount: 0,
        },
        ok: true,
        privatePath: '/private/store.sqlite',
        requestFingerprint: 'fingerprint',
        revision: 'revision-1',
      }).success,
    ).toBe(false);
    expect(
      safeParse(sessionPageOutputSchema, {
        error: {
          message: 'The revision expired.',
          privateReason: '/private/store.sqlite',
          revision: 'revision-1',
          tag: 'RevisionExpired',
        },
        ok: false,
        requestFingerprint: 'fingerprint',
        revision: 'revision-1',
      }).success,
    ).toBe(false);
    expect(
      safeParse(sessionPageOutputSchema, {
        ok: true,
        requestFingerprint: 'fingerprint',
        revision: 'revision-1',
      }).success,
    ).toBe(false);

    expect(
      safeParse(sessionDetailResponseSchema, {
        message: 'Local history is unavailable.',
        reason: 'history-unavailable',
        status: 'unavailable',
      }).success,
    ).toBe(true);
    expect(
      safeParse(sessionDetailResponseSchema, {
        message: 'Local history is unavailable.',
        privatePath: '/private/history.jsonl',
        reason: 'history-unavailable',
        status: 'unavailable',
      }).success,
    ).toBe(false);

    expect(
      safeParse(sessionVcsResolveResponseSchema, {
        reason: 'not-local',
        status: 'unavailable',
      }).success,
    ).toBe(true);
    expect(
      safeParse(sessionVcsResolveResponseSchema, {
        pullRequests: [],
        repositoryUrl: 'file:///private/repository',
        status: 'available',
      }).success,
    ).toBe(false);
  });

  test('rejects non-JSON accessors before an output can cross the contract boundary', () => {
    const output = {
      ok: true,
      requestFingerprint: 'fingerprint',
      revision: 'revision-1',
    } as Record<string, unknown>;
    Object.defineProperty(output, 'data', {
      enumerable: true,
      get: () => ({ privatePath: '/private/store.sqlite' }),
    });

    expect(safeParse(sessionPageOutputSchema, output).success).toBe(false);
  });
});
