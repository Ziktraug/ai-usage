import { describe, expect, test } from 'bun:test';
import { checkboxFilterIncludedCount, checkboxFilterSummary, toggleCheckboxFilterOption } from './checkbox-filter';

const options = ['alpha', 'beta', 'gamma'];
const label = (value: string): string => `${value} machine`;

describe('checkbox filter model', () => {
  test('summarizes all, one, and several selected values', () => {
    expect(checkboxFilterSummary([], 'All machines', 'machines', label)).toBe('All machines');
    expect(checkboxFilterSummary(['alpha'], 'All machines', 'machines', label)).toBe('alpha machine');
    expect(checkboxFilterSummary(['alpha', 'beta'], 'All machines', 'machines', label)).toBe('2 machines');
  });

  test('narrows from neutral and returns to neutral after removing the last option', () => {
    expect(toggleCheckboxFilterOption([], options, 'beta', true)).toEqual(['beta']);
    expect(toggleCheckboxFilterOption(['beta'], options, 'beta', false)).toEqual([]);
  });

  test('normalizes an explicit complete selection back to all', () => {
    expect(toggleCheckboxFilterOption(['alpha', 'beta'], options, 'gamma', true)).toEqual([]);
  });

  test('keeps option order while adding and removing values', () => {
    expect(toggleCheckboxFilterOption(['gamma'], options, 'alpha', true)).toEqual(['alpha', 'gamma']);
    expect(toggleCheckboxFilterOption(['alpha', 'gamma'], options, 'alpha', false)).toEqual(['gamma']);
  });

  test('preserves unknown URL values and counts only included known options', () => {
    expect(toggleCheckboxFilterOption(['ghost'], options, 'alpha', true)).toEqual(['alpha', 'ghost']);
    expect(checkboxFilterIncludedCount([], options)).toBe(3);
    expect(checkboxFilterIncludedCount(['alpha', 'ghost'], options)).toBe(1);
  });
});
