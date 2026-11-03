import { expect, test } from 'bun:test';
import { projectSessionPage, type SessionQueryRequest } from '@ai-usage/report-core/session-query';
import { campaignMapFixtureRows } from '../campaign-map-fixture';
import { sessionDetailFixtureResponse } from '../lib/features/sessions/detail/session-detail.fixtures';
import { readPromptCorpusForServer } from './prompt-corpus.server';

const query: SessionQueryRequest = {
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], query: '' },
  pageSize: 1,
  range: { from: null, to: null },
  revision: 'r1',
  sort: [{ id: 'date', desc: true }],
};
const rows = campaignMapFixtureRows.map((row) => ({ ...row, origin: 'human' as const }));
const page = (q: SessionQueryRequest) => {
  const data = projectSessionPage(rows, q);
  return Promise.resolve({
    ok: true as const,
    data,
    revision: q.revision,
    requestFingerprint: data.requestFingerprint,
  });
};
test('body search keeps continuation even when a scanned batch has no match', async () => {
  const result = await readPromptCorpusForServer(
    { query, cursor: null, search: 'zz-no-match', includeUndeclared: false },
    { readPage: page, readDetail: (r) => Promise.resolve(sessionDetailFixtureResponse(r.revision, r.rowId)) },
  );
  expect(result.entries).toEqual([]);
  expect(result.scannedSessions).toBe(1);
  expect(result.nextCursor).not.toBeNull();
});
test('undeclared origin is opt-in and unavailable native histories remain visible in coverage', async () => {
  const readPage = (q: SessionQueryRequest) => {
    const data = projectSessionPage(
      campaignMapFixtureRows.map(({ origin: _origin, ...row }) => row),
      q,
    );
    return Promise.resolve({
      ok: true as const,
      data,
      revision: q.revision,
      requestFingerprint: data.requestFingerprint,
    });
  };
  let reads = 0;
  const readDetail = () => {
    reads++;
    return Promise.resolve({
      status: 'unavailable' as const,
      reason: 'not-local' as const,
      message: 'Imported history',
    });
  };
  await readPromptCorpusForServer(
    { query, cursor: null, search: '', includeUndeclared: false },
    { readPage, readDetail },
  );
  expect(reads).toBe(0);
  const result = await readPromptCorpusForServer(
    { query, cursor: null, search: '', includeUndeclared: true },
    { readPage, readDetail },
  );
  expect(result.unavailableSessions).toBe(1);
});
test('a session with 120 prompts continues without losing or repeating prompts', async () => {
  const readPage = (q: SessionQueryRequest) => {
    const data = projectSessionPage(rows.slice(0, 1), q);
    return Promise.resolve({
      ok: true as const,
      data,
      revision: q.revision,
      requestFingerprint: data.requestFingerprint,
    });
  };
  const readDetail = (r: { revision: string; rowId: string }) => {
    const response = sessionDetailFixtureResponse(r.revision, r.rowId);
    if (response.status !== 'available') {
      throw new Error('Expected fixture detail');
    }
    response.detail.prompts = Array.from({ length: 120 }, (_, i) => ({
      id: `p${i}`,
      text: `Prompt ${i}`,
      timestamp: '2026-10-01T00:00:00.000Z',
      truncated: false,
    }));
    return Promise.resolve(response);
  };
  const input = { query, cursor: null, search: '', includeUndeclared: false };
  const first = await readPromptCorpusForServer(input, { readPage, readDetail });
  expect(first.entries).toHaveLength(100);
  const second = await readPromptCorpusForServer({ ...input, cursor: first.nextCursor }, { readPage, readDetail });
  expect(second.entries).toHaveLength(20);
  expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(120);
  expect(second.nextCursor).toBeNull();
  await expect(
    readPromptCorpusForServer({ ...input, cursor: first.nextCursor, search: 'changed' }, { readPage, readDetail }),
  ).rejects.toThrow('another search');
});
test('search matches late text and intervention dates independently of session birth', async () => {
  const readPage = (q: SessionQueryRequest) => {
    expect(q.range).toEqual({ from: null, to: null });
    const data = projectSessionPage(rows.slice(0, 1), q);
    return Promise.resolve({
      ok: true as const,
      data,
      revision: q.revision,
      requestFingerprint: data.requestFingerprint,
    });
  };
  const readDetail = (r: { revision: string; rowId: string }) => {
    const response = sessionDetailFixtureResponse(r.revision, r.rowId);
    if (response.status !== 'available') {
      throw new Error('Expected fixture detail');
    }
    response.detail.prompts = [
      { id: 'late', text: `${'x'.repeat(3000)} needle`, timestamp: '2026-10-01T00:00:00.000Z', truncated: false },
    ];
    return Promise.resolve(response);
  };
  const result = await readPromptCorpusForServer(
    {
      query: { ...query, range: { from: '2026-09-01T00:00:00.000Z', to: null } },
      cursor: null,
      search: 'needle',
      includeUndeclared: false,
    },
    { readPage, readDetail },
  );
  expect(result.entries[0]?.text).toContain('needle');
  expect(result.entries[0]?.partial).toBe(true);
});

test('expired revisions remain distinct from unavailable native history', async () => {
  await expect(
    readPromptCorpusForServer(
      { query, cursor: null, search: '', includeUndeclared: false },
      {
        readPage: () =>
          Promise.resolve({
            ok: false,
            revision: query.revision,
            requestFingerprint: 'expired',
            error: { tag: 'RevisionExpired', message: 'Expired', revision: query.revision },
          }),
        readDetail: () => {
          throw new Error('Must not read native history');
        },
      },
    ),
  ).rejects.toThrow('revision has expired');
});
