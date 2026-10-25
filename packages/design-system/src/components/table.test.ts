import { describe, expect, test } from 'bun:test';
import { sessionsTable } from './table';

// A class that positions a cell (`td`, `td:last-child`, …), as opposed to the chevron's `::after`.
const POSITIONED_CELL_PATTERN = /_td(?::[\w-]+(?:\([^)]*\))?)*\]:pos_/;

describe('Sessions table row rings', () => {
  test('anchor the chevron on the row, so no positioned cell paints over the row ring', () => {
    // A positioned cell paints after the row's outline, so its fill would cover the keyboard focus
    // ring and the forced-colours selection ring along its edges.
    expect(sessionsTable).toContain('[&_tbody_tr[data-selected]]:pos_relative');
    expect(sessionsTable).toContain('[&_tbody_tr[data-selected]_td:last-child::after]:pos_absolute');
    expect(sessionsTable).not.toMatch(POSITIONED_CELL_PATTERN);
  });

  test('leave the forced-colours selection ring to the row, with no ring of a cell inside it', () => {
    expect(sessionsTable).not.toContain('highContrast:ring');
    expect(sessionsTable).not.toContain('highContrast:outline');
  });
});
