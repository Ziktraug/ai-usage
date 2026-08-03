import { describe, expect, test } from 'bun:test';
import { exportManualMergeBundle } from './sync-solid-client';

describe('Solid sync client cancellation', () => {
  test('preserves the exact pre-abort reason instead of mapping it to Unavailable', async () => {
    const controller = new AbortController();
    const reason = { reason: 'manual-export-view-unmounted' };
    controller.abort(reason);

    try {
      await exportManualMergeBundle(controller.signal);
      throw new Error('Expected manual export cancellation');
    } catch (error) {
      expect(error).toBe(reason);
    }
  });
});
