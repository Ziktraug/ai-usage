import { expect, test } from 'bun:test';
import { isMemoryProposalUnavailable } from './memory-errors';

test('only a not-found refusal marks an addressed proposal as unavailable', () => {
  expect(isMemoryProposalUnavailable({ code: 'Unavailable', data: { reason: 'not-found' } })).toBe(true);
  expect(isMemoryProposalUnavailable({ code: 'Unavailable', data: { reason: 'memory-review-unavailable' } })).toBe(
    false,
  );
  expect(isMemoryProposalUnavailable({ code: 'ForbiddenDemo' })).toBe(false);
  expect(isMemoryProposalUnavailable(new Error('not-found'))).toBe(false);
});
