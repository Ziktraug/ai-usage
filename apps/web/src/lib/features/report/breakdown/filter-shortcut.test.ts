import { describe, expect, test } from 'bun:test';
import { shouldFocusReportFilter } from './filter-shortcut';

const shortcut = (overrides: Partial<Parameters<typeof shouldFocusReportFilter>[0]> = {}): boolean =>
  shouldFocusReportFilter({
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    editableTarget: false,
    isComposing: false,
    key: '/',
    metaKey: false,
    ...overrides,
  });

describe('report filter shortcut', () => {
  test('accepts an unmodified slash outside an editable target', () => {
    expect(shortcut()).toBe(true);
  });

  test('does not steal typing, handled events, or modified shortcuts', () => {
    expect(shortcut({ editableTarget: true })).toBe(false);
    expect(shortcut({ defaultPrevented: true })).toBe(false);
    expect(shortcut({ key: '?' })).toBe(false);
    expect(shortcut({ altKey: true })).toBe(false);
    expect(shortcut({ ctrlKey: true })).toBe(false);
    expect(shortcut({ metaKey: true })).toBe(false);
    expect(shortcut({ isComposing: true })).toBe(false);
  });
});
