import { describe, expect, test } from 'bun:test';
import { compactRevision, pendingAriaBusyAttributes, revisionDisplayBounds } from './model';

describe('Sources presentation model', () => {
  test('exposes pending state only while a source command is active', () => {
    expect(pendingAriaBusyAttributes(false)).toEqual({});
    expect(pendingAriaBusyAttributes(true)).toEqual({ 'aria-busy': 'true' });
  });

  test('keeps revision compaction stable at and beyond the named boundary', () => {
    const boundaryRevision = 'r'.repeat(revisionDisplayBounds.maxInlineLength);
    expect(compactRevision(boundaryRevision)).toBe(boundaryRevision);
    expect(compactRevision(`${boundaryRevision}x`)).toBe(
      `${'r'.repeat(revisionDisplayBounds.prefixLength)}…${'r'.repeat(revisionDisplayBounds.suffixLength - 1)}x`,
    );
  });
});
