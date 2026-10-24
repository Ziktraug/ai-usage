import { describe, expect, test } from 'bun:test';
import { createFrameworkScrollPreservation } from './framework-scroll-preservation';

const SESSIONS = 'http://local/?tab=sessions';
const OVERVIEW = 'http://local/?tab=overview';

describe('framework scroll preservation', () => {
  test('preserves scroll only for the navigation that asked for it, once', () => {
    const preservation = createFrameworkScrollPreservation();

    preservation.request(SESSIONS, true);

    expect(preservation.consume(SESSIONS)).toBe(true);
    expect(preservation.consume(SESSIONS)).toBe(false);
  });

  test('does not leak into a navigation that superseded the one that asked', () => {
    const preservation = createFrameworkScrollPreservation();

    // SvelteKit skips `beforeNavigate` for a navigation that starts while another is in flight, but
    // still runs `onNavigate` for it; the aborted one never reaches `onNavigate`.
    preservation.request(SESSIONS, true);

    expect(preservation.consume(OVERVIEW)).toBe(false);
    expect(preservation.consume(SESSIONS)).toBe(false);
  });

  test('forgets a request whose navigation was cancelled or failed', () => {
    const preservation = createFrameworkScrollPreservation();

    preservation.request(SESSIONS, true);
    preservation.cancel();

    expect(preservation.consume(SESSIONS)).toBe(false);
  });

  test('a navigation that does not ask replaces an earlier request', () => {
    const preservation = createFrameworkScrollPreservation();

    preservation.request(SESSIONS, true);
    preservation.request(SESSIONS, false);

    expect(preservation.consume(SESSIONS)).toBe(false);
  });

  test('a navigation without a target never preserves', () => {
    const preservation = createFrameworkScrollPreservation();

    preservation.request(undefined, true);

    expect(preservation.consume(undefined)).toBe(false);
  });
});
