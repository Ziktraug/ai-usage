import { expect, test } from 'bun:test';
import { demoReportPayload } from './report-data';
import {
  mergeWebReportSlices,
  parseReportRequestFingerprint,
  parseReportRevision,
  parseWebReportSliceRequest,
  reportSliceRequestFingerprint,
  splitWebReportPayload,
  toExportReportPayload,
  toWebReportPayload,
} from './web-report-payload';

test('removes duplicated table rows without cloning report rows', () => {
  const payload = toWebReportPayload(demoReportPayload);

  expect('tableRows' in payload).toBe(false);
  expect(payload.rows).toBe(demoReportPayload.rows);
});

test('restores compatibility table rows for standalone HTML export', () => {
  const webPayload = toWebReportPayload(demoReportPayload);
  const exportPayload = toExportReportPayload(webPayload);

  expect(exportPayload.tableRows).toEqual(webPayload.rows);
  expect(exportPayload.rows).toBe(webPayload.rows);
});

test('preserves the report row limit when restoring standalone export compatibility', () => {
  const webPayload = toWebReportPayload({
    ...demoReportPayload,
    filters: { ...demoReportPayload.filters, limit: 2 },
    omittedRows: demoReportPayload.rows.length - 2,
  });

  const exportPayload = toExportReportPayload(webPayload);

  expect(exportPayload.tableRows).toEqual(webPayload.rows.slice(0, 2));
  expect(exportPayload.omittedRows).toBe(2);
});

test('rejects non-JSON facet values at the server-function boundary', () => {
  expect(() =>
    toWebReportPayload({
      ...demoReportPayload,
      facets: { cursor: { collectedAt: new Date() } },
    }),
  ).toThrow('Report facets must contain only JSON-serializable values');
});

test('preserves JSON datasets at the server-function boundary', () => {
  const payload = toWebReportPayload(demoReportPayload);

  expect(JSON.stringify(payload.datasets)).toBe(JSON.stringify(demoReportPayload.datasets));
  expect(JSON.stringify(toExportReportPayload(payload).datasets)).toBe(JSON.stringify(demoReportPayload.datasets));
});

test('drops legacy Cursor attribution when the canonical dataset is present', () => {
  const cursorCommitAttribution = [...(demoReportPayload.datasets?.cursorCommitAttribution ?? [])];
  const payload = toWebReportPayload({
    ...demoReportPayload,
    datasets: { cursorCommitAttribution },
    facets: {
      cursor: { commitAttribution: cursorCommitAttribution },
      retained: { value: 'keep me' },
    },
  });

  expect(JSON.stringify(payload.datasets?.cursorCommitAttribution)).toBe(JSON.stringify(cursorCommitAttribution));
  expect(payload.facets).toEqual({ retained: { value: 'keep me' } });
});

test('rejects non-JSON dataset values at the server-function boundary', () => {
  expect(() =>
    toWebReportPayload({
      ...demoReportPayload,
      datasets: { generatedAt: new Date() },
    }),
  ).toThrow('Report datasets must contain only JSON-serializable values');
});

test('validates opaque report revisions without normalizing their identity', () => {
  expect(String(parseReportRevision('report-2026.07.13:abc_123'))).toBe('report-2026.07.13:abc_123');
  expect(() => parseReportRevision('')).toThrow('Report revision');
  expect(() => parseReportRevision(' revision-with-whitespace')).toThrow('Report revision');
  expect(() => parseReportRevision(42)).toThrow('Report revision');
});

test('validates exact-revision slice requests and preserves their canonical fingerprint', () => {
  const requestFingerprint = reportSliceRequestFingerprint('rows');
  expect(
    parseWebReportSliceRequest({
      requestFingerprint,
      revision: 'revision-a',
    }),
  ).toEqual({ requestFingerprint, revision: parseReportRevision('revision-a') });
  expect(String(parseReportRequestFingerprint(requestFingerprint))).toBe(requestFingerprint);
  expect(() => parseWebReportSliceRequest({ requestFingerprint, revision: 'revision-a', unsupported: true })).toThrow(
    'unsupported fields',
  );
  expect(() => parseWebReportSliceRequest({ revision: 'revision-a' })).toThrow('fingerprint');
});

test('splits and merges a report payload at one exact revision', () => {
  const payload = toWebReportPayload(demoReportPayload);
  const revision = parseReportRevision('revision-a');
  const slices = splitWebReportPayload(payload, revision);

  expect(slices.rowsSlice).toEqual({ revision, rows: payload.rows });
  expect(slices.rowsSlice.rows).toBe(payload.rows);
  expect('rows' in slices.supportSlice.payloadWithoutRows).toBe(false);
  expect(mergeWebReportSlices(slices.rowsSlice, slices.supportSlice)).toEqual(payload);
});

test('refuses to merge slices from different revisions', () => {
  const payload = toWebReportPayload(demoReportPayload);
  const first = splitWebReportPayload(payload, parseReportRevision('revision-a'));
  const second = splitWebReportPayload(payload, parseReportRevision('revision-b'));

  expect(() => mergeWebReportSlices(first.rowsSlice, second.supportSlice)).toThrow(
    'Report slices must use the same revision',
  );
});
