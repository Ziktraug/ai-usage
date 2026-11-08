import { expect, test } from 'bun:test';
import { summarizeWarnings } from './warning-summary';

test('warnings group identical visible messages in first occurrence order without losing input detail', () => {
  const warnings = [
    { code: 'recordRejected', message: 'Rejected record' },
    { code: 'recordRejected', message: 'Another record' },
    { code: 'recordRejected', message: 'Rejected record' },
  ];
  expect(summarizeWarnings(warnings)).toEqual([
    { label: 'Warning', message: 'Rejected record', count: 2 },
    { label: 'Warning', message: 'Another record', count: 1 },
  ]);
  expect(warnings).toHaveLength(3);
  expect(summarizeWarnings([])).toEqual([]);
});
