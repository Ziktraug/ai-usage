import { expect, test } from 'bun:test';
import { harnessFillFor } from './harness-fill';

// The passive closure itself (no component or framework runtime) is enforced by
// tools/check-package-boundaries.ts.
test('neutral harness fills preserve known family and fallback semantics', () => {
  expect(harnessFillFor('Claude Code')).toBe(harnessFillFor('claude'));
  expect(harnessFillFor('codex-cli')).toBe(harnessFillFor('codex'));
  expect(harnessFillFor('Cursor')).toBe(harnessFillFor('cursor'));
  expect(harnessFillFor('OpenCode')).toBe(harnessFillFor('opencode'));
  expect(harnessFillFor('Gemini CLI')).toBe(harnessFillFor('gemini'));
  expect(harnessFillFor('unknown')).toBeUndefined();
});
