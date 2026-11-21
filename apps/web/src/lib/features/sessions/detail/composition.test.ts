import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

// Still a source-text check: keyed-each collisions and the wall-clock phase tracks show only in a client
// render after the scale toggle, and no browser fixture session carries duplicate or phased rows yet.
// The Drawer composition this file used to read is driven in Playwright (dashboard.spec.ts,
// session-viewport-geometry.spec.ts, campaign-label-overrides.spec.ts).
describe('P4 stable Drawer composition', () => {
  test('keeps phase keys collision-safe and phase bands on the selected timeline scale', () => {
    const analysis = source('./session-analysis.svelte');

    expect(analysis).toContain('phaseRenderKey(phase, index)');
    expect(analysis).toContain('phase.startAt');
    expect(analysis).toContain('phase.endAt');
    expect(analysis).toContain('index');
    expect(analysis.match(/@render renderTimelineAxis\(/g)).toHaveLength(2);
    expect(analysis.match(/scaleMode === 'wall-clock' && wallClockTrack/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
