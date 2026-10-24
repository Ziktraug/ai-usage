import { describe, expect, test } from 'bun:test';
import { sessionsTable } from './table';

describe('Sessions table selection under forced colours', () => {
  test('rings the positioned last cell of the selected row, which paints over the row ring', () => {
    const lastCell = '[&_tbody_tr[data-selected]_td:last-child]';
    const selectedLastCell = '[&_tbody_tr[data-selected="true"]:not(:focus-visible)_td:last-child]';

    expect(sessionsTable).toContain(`${lastCell}:pos_relative`);
    expect(sessionsTable).toContain(`${selectedLastCell}:highContrast:ring_2px_solid_Highlight`);
    expect(sessionsTable).toContain(`${selectedLastCell}:highContrast:ring-o_-2px`);
  });
});
