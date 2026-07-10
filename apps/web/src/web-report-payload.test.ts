import { expect, test } from 'bun:test';
import { demoReportPayload } from './report-data';
import { toExportReportPayload, toWebReportPayload } from './web-report-payload';

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

test('rejects non-JSON dataset values at the server-function boundary', () => {
  expect(() =>
    toWebReportPayload({
      ...demoReportPayload,
      datasets: { generatedAt: new Date() },
    }),
  ).toThrow('Report datasets must contain only JSON-serializable values');
});
